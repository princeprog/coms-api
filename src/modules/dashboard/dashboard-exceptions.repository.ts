import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { DATABASE } from '../../database/database.module';
import type { DB } from '../../database/db';
import { scopeSql, type TodayScope } from './dashboard-today.repository';

/** Completed business days covered, split into four 7-day weeks. */
export const EXCEPTION_WEEKS = 4;
const DAYS = EXCEPTION_WEEKS * 7;
const CASHIER_LIMIT = 25;

export type ExceptionWeekRow = {
  branch_id: string;
  branch_name: string;
  branch_status: string;
  week: number;
  week_start: string;
  shortage_lines: number;
  uncosted_shortage_lines: number;
  shortage_value: string;
  cash_short_shifts: number;
  cash_short_amount: string;
  receiving_differences: number;
  void_count: number;
  void_amount: string;
};

@Injectable()
export class DashboardExceptionsRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DB>) {}

  /** One row per branch and week, oldest week first; today is excluded. */
  async weekly(scope: TodayScope) {
    const result = await sql<ExceptionWeekRow>`
      WITH ${scopeSql(scope)},
      range AS (SELECT day.today - ${DAYS}::int AS start, day.today AS stop FROM day),
      weeks AS (
        SELECT w AS week, (range.start + 7 * w)::date AS week_start
        FROM range, generate_series(0, ${EXCEPTION_WEEKS - 1}::int) AS w
      ),
      shortages AS (
        SELECT r.branch_id, (r.business_date - range.start) / 7 AS week,
          count(*)::int AS lines,
          count(*) FILTER (WHERE coalesce(i.unit_cost, c.average_unit_cost) IS NULL)::int AS uncosted,
          sum(-i.variance_quantity * coalesce(i.unit_cost, c.average_unit_cost)) AS value
        FROM daily_branch_reports r CROSS JOIN range
        JOIN scope b ON b.id = r.branch_id
        JOIN daily_branch_report_items i
          ON i.daily_branch_report_id = r.id AND i.variance_quantity < 0
        LEFT JOIN stock_item_costs c ON c.stock_item_id = i.stock_item_id
        WHERE r.status IN ('SUBMITTED', 'APPROVED')
          AND r.business_date >= range.start AND r.business_date < range.stop
        GROUP BY 1, 2
      ),
      cash AS (
        SELECT rs.branch_id, (rs.business_date - range.start) / 7 AS week,
          count(*)::int AS shifts, sum(-rs.cash_difference) AS amount
        FROM register_shifts rs CROSS JOIN range
        JOIN scope b ON b.id = rs.branch_id
        WHERE rs.status IN ('CLOSED', 'REVIEWED') AND rs.cash_difference < 0
          AND rs.business_date >= range.start AND rs.business_date < range.stop
        GROUP BY 1, 2
      ),
      receiving AS (
        SELECT d.branch_id, (coms_business_date(dd.reported_at) - range.start) / 7 AS week,
          count(*)::int AS differences
        FROM dispatch_discrepancies dd JOIN dispatches d ON d.id = dd.dispatch_id
        CROSS JOIN range JOIN scope b ON b.id = d.branch_id
        WHERE dd.reported_at >= coms_business_day_start(range.start)
          AND dd.reported_at < coms_business_day_start(range.stop)
        GROUP BY 1, 2
      ),
      voids AS (
        SELECT s.branch_id, (coms_business_date(s.occurred_at) - range.start) / 7 AS week,
          count(*)::int AS voids, sum(s.total_amount) AS amount
        FROM sales s CROSS JOIN range JOIN scope b ON b.id = s.branch_id
        WHERE s.status = 'VOIDED'
          AND s.occurred_at >= coms_business_day_start(range.start)
          AND s.occurred_at < coms_business_day_start(range.stop)
        GROUP BY 1, 2
      )
      SELECT b.id AS branch_id, b.branch_name, b.status AS branch_status,
        w.week, w.week_start::text AS week_start,
        coalesce(sh.lines, 0) AS shortage_lines,
        coalesce(sh.uncosted, 0) AS uncosted_shortage_lines,
        round(coalesce(sh.value, 0), 2)::numeric(14,2)::text AS shortage_value,
        coalesce(c.shifts, 0) AS cash_short_shifts,
        round(coalesce(c.amount, 0), 2)::numeric(14,2)::text AS cash_short_amount,
        coalesce(r.differences, 0) AS receiving_differences,
        coalesce(v.voids, 0) AS void_count,
        round(coalesce(v.amount, 0), 2)::numeric(14,2)::text AS void_amount
      FROM scope b CROSS JOIN weeks w
      LEFT JOIN shortages sh ON sh.branch_id = b.id AND sh.week = w.week
      LEFT JOIN cash c ON c.branch_id = b.id AND c.week = w.week
      LEFT JOIN receiving r ON r.branch_id = b.id AND r.week = w.week
      LEFT JOIN voids v ON v.branch_id = b.id AND v.week = w.week
      ORDER BY b.branch_name, b.id, w.week
    `.execute(this.db);
    return result.rows;
  }

  /**
   * Cash differences per shift opener and voids per selling cashier over the
   * same completed days, most shortages first.
   */
  async cashiers(scope: TodayScope) {
    const result = await sql<{
      user_id: string;
      full_name: string;
      branches: string[];
      shifts: number;
      short_shifts: number;
      short_amount: string;
      over_shifts: number;
      over_amount: string;
      sales_count: number;
      void_count: number;
      void_amount: string;
      total: number;
    }>`
      WITH ${scopeSql(scope)},
      range AS (SELECT day.today - ${DAYS}::int AS start, day.today AS stop FROM day),
      closed AS (
        SELECT rs.opened_by_user_id AS user_id, b.branch_name, rs.cash_difference
        FROM register_shifts rs CROSS JOIN range JOIN scope b ON b.id = rs.branch_id
        WHERE rs.status IN ('CLOSED', 'REVIEWED')
          AND rs.business_date >= range.start AND rs.business_date < range.stop
      ),
      sold AS (
        SELECT s.cashier_user_id AS user_id, b.branch_name, s.status, s.total_amount
        FROM sales s CROSS JOIN range JOIN scope b ON b.id = s.branch_id
        WHERE s.occurred_at >= coms_business_day_start(range.start)
          AND s.occurred_at < coms_business_day_start(range.stop)
      ),
      shift_totals AS (
        SELECT user_id, count(*)::int AS shifts,
          count(*) FILTER (WHERE cash_difference < 0)::int AS short_shifts,
          coalesce(sum(-cash_difference) FILTER (WHERE cash_difference < 0), 0) AS short_amount,
          count(*) FILTER (WHERE cash_difference > 0)::int AS over_shifts,
          coalesce(sum(cash_difference) FILTER (WHERE cash_difference > 0), 0) AS over_amount
        FROM closed GROUP BY user_id
      ),
      sale_totals AS (
        SELECT user_id, count(*)::int AS sales_count,
          count(*) FILTER (WHERE status = 'VOIDED')::int AS void_count,
          coalesce(sum(total_amount) FILTER (WHERE status = 'VOIDED'), 0) AS void_amount
        FROM sold GROUP BY user_id
      ),
      presence AS (
        SELECT user_id, branch_name FROM closed
        UNION SELECT user_id, branch_name FROM sold
      ),
      people AS (
        SELECT user_id, array_agg(branch_name ORDER BY branch_name) AS branches
        FROM presence GROUP BY user_id
      )
      SELECT p.user_id, u.full_name, p.branches,
        coalesce(st.shifts, 0) AS shifts,
        coalesce(st.short_shifts, 0) AS short_shifts,
        round(coalesce(st.short_amount, 0), 2)::numeric(14,2)::text AS short_amount,
        coalesce(st.over_shifts, 0) AS over_shifts,
        round(coalesce(st.over_amount, 0), 2)::numeric(14,2)::text AS over_amount,
        coalesce(sa.sales_count, 0) AS sales_count,
        coalesce(sa.void_count, 0) AS void_count,
        round(coalesce(sa.void_amount, 0), 2)::numeric(14,2)::text AS void_amount,
        count(*) OVER ()::int AS total
      FROM people p JOIN coms_auth.users u ON u.id = p.user_id
      LEFT JOIN shift_totals st ON st.user_id = p.user_id
      LEFT JOIN sale_totals sa ON sa.user_id = p.user_id
      ORDER BY coalesce(st.short_shifts, 0) DESC, coalesce(st.short_amount, 0) DESC,
        coalesce(sa.void_count, 0) DESC, u.full_name, p.user_id
      LIMIT ${CASHIER_LIMIT}
    `.execute(this.db);
    return {
      total: result.rows[0]?.total ?? 0,
      items: result.rows.map(({ total: _total, ...row }) => row),
    };
  }
}
