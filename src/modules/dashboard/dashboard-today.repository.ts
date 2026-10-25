import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { DATABASE } from '../../database/database.module';
import type { DB } from '../../database/db';
import { attentionSummary } from './dashboard-attention.repository';
import { reportProgress } from './dashboard-report-progress.repository';
import {
  countShortages,
  reportBacklog,
} from './dashboard-report-health.repository';

/** Branch IDs the caller may see; null means every branch. */
export type TodayScope = string[] | null;

export const ATTENTION_KEYS = [
  'deliveries_overdue',
  'open_discrepancies',
  'shifts_open_past_day',
  'cash_shortages',
  'stock_below_zero',
  'commissary_stock_below_zero',
  'branch_stock_low',
  'commissary_stock_low',
  'reports_missing',
  'reports_returned',
  'reports_to_review',
  'late_counts_to_review',
  'shifts_to_review',
  'dispatches_draft',
  'deliveries_in_transit',
] as const;
export type AttentionKey = (typeof ATTENTION_KEYS)[number];

const money = (value: RawBuilder<unknown>) =>
  sql`round(${value}, 2)::numeric(14,2)::text`;

/** Scope and business-day CTEs shared by dashboard queries. */
export function scopeSql(scope: TodayScope) {
  const filter =
    scope === null
      ? sql`true`
      : scope.length
        ? sql`id = ANY(${scope}::uuid[])`
        : sql`false`;
  return sql`
    scope AS (SELECT id, branch_name, status FROM branches WHERE ${filter}),
    day AS (SELECT coms_business_date(now()) AS today)
  `;
}

@Injectable()
export class DashboardTodayRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DB>) {}

  private scope(scope: TodayScope) {
    return scopeSql(scope);
  }

  async businessDate() {
    const result = await sql<{ today: string; as_of: Date }>`
      SELECT coms_business_date(now())::text AS today, now() AS as_of
    `.execute(this.db);
    return result.rows[0];
  }

  /** Today so far and yesterday up to the same moment. */
  async totals(scope: TodayScope) {
    const result = await sql<{
      net_sales: string;
      sales_count: number;
      average_sale: string | null;
      items_sold: string;
      void_count: number;
      food_cost: string;
      gross_profit: string;
      cost_coverage_percent: string | null;
      yesterday_net_sales: string;
      yesterday_sales_count: number;
      last_week_net_sales: string;
      last_week_sales_count: number;
    }>`
      WITH ${this.scope(scope)},
      today_sales AS (
        SELECT s.id, s.status, s.total_amount FROM sales s
        JOIN scope b ON b.id = s.branch_id, day
        WHERE s.created_at >= coms_business_day_start(day.today)
          AND s.created_at < coms_business_day_end(day.today)
      ),
      completed AS (SELECT * FROM today_sales WHERE status = 'COMPLETED'),
      lines AS (
        SELECT si.quantity, si.line_total,
          coalesce((SELECT sum(x.quantity_consumed * x.unit_cost)
            FROM sale_item_consumptions x WHERE x.sale_item_id = si.id), 0) AS cost,
          EXISTS (SELECT 1 FROM sale_item_consumptions x WHERE x.sale_item_id = si.id)
            AND NOT EXISTS (SELECT 1 FROM sale_item_consumptions x
              WHERE x.sale_item_id = si.id AND x.unit_cost IS NULL) AS costed
        FROM sale_items si JOIN completed c ON c.id = si.sale_id
      ),
      yesterday AS (
        SELECT s.total_amount FROM sales s
        JOIN scope b ON b.id = s.branch_id, day
        WHERE s.status = 'COMPLETED'
          AND s.created_at >= coms_business_day_start(day.today - 1)
          AND s.created_at < least(now() - interval '1 day', coms_business_day_end(day.today - 1))
      ),
      last_week AS (
        SELECT s.total_amount FROM sales s
        JOIN scope b ON b.id = s.branch_id, day
        WHERE s.status = 'COMPLETED'
          AND s.created_at >= coms_business_day_start(day.today - 7)
          AND s.created_at < least(now() - interval '7 days', coms_business_day_end(day.today - 7))
      ),
      sums AS (
        SELECT
          (SELECT coalesce(sum(total_amount), 0) FROM completed) AS net_sales,
          (SELECT count(*)::int FROM completed) AS sales_count,
          (SELECT count(*)::int FROM today_sales WHERE status = 'VOIDED') AS void_count,
          (SELECT coalesce(sum(quantity), 0) FROM lines) AS items_sold,
          (SELECT coalesce(sum(cost), 0) FROM lines) AS food_cost,
          (SELECT coalesce(sum(line_total) FILTER (WHERE costed), 0) FROM lines) AS costed_sales,
          (SELECT coalesce(sum(total_amount), 0) FROM yesterday) AS yesterday_net_sales,
          (SELECT count(*)::int FROM yesterday) AS yesterday_sales_count,
          (SELECT coalesce(sum(total_amount), 0) FROM last_week) AS last_week_net_sales,
          (SELECT count(*)::int FROM last_week) AS last_week_sales_count
      )
      SELECT ${money(sql`net_sales`)} AS net_sales, sales_count,
        CASE WHEN sales_count > 0 THEN ${money(sql`net_sales / sales_count`)} END AS average_sale,
        trim_scale(items_sold)::text AS items_sold, void_count,
        ${money(sql`food_cost`)} AS food_cost,
        ${money(sql`net_sales - round(food_cost, 2)`)} AS gross_profit,
        trim_scale(round(100 * costed_sales / nullif(net_sales, 0), 1))::text AS cost_coverage_percent,
        ${money(sql`yesterday_net_sales`)} AS yesterday_net_sales,
        yesterday_sales_count,
        ${money(sql`last_week_net_sales`)} AS last_week_net_sales,
        last_week_sales_count
      FROM sums
    `.execute(this.db);
    return result.rows[0];
  }

  attention(scope: TodayScope) {
    return attentionSummary(this.db, this.scope(scope));
  }

  reportProgress(scope: TodayScope) {
    return reportProgress(this.db, this.scope(scope));
  }

  countShortages(scope: TodayScope) {
    return countShortages(this.db, this.scope(scope));
  }

  reportBacklog(scope: TodayScope) {
    return reportBacklog(this.db, this.scope(scope));
  }

  /** Register, sales and yesterday's report for each branch. */
  async branches(scope: TodayScope) {
    const result = await sql<{
      branch_id: string;
      branch_name: string;
      status: string;
      shift_id: string | null;
      shift_number: number | null;
      cashier_name: string | null;
      opened_at: Date | null;
      sales_count: number;
      net_sales: string;
      last_sale_at: Date | null;
      last_week_net_sales: string;
      yesterday_report_status: string | null;
      yesterday_sales_count: number;
    }>`
      WITH ${this.scope(scope)},
      today_sales AS (
        SELECT s.branch_id, s.status, s.total_amount, s.created_at FROM sales s
        JOIN scope b ON b.id = s.branch_id, day
        WHERE s.created_at >= coms_business_day_start(day.today)
          AND s.created_at < coms_business_day_end(day.today)
      ),
      per_branch AS (
        SELECT branch_id,
          count(*) FILTER (WHERE status = 'COMPLETED')::int AS sales_count,
          coalesce(sum(total_amount) FILTER (WHERE status = 'COMPLETED'), 0) AS net_sales,
          max(created_at) AS last_sale_at
        FROM today_sales GROUP BY branch_id
      ),
      -- Same weekday last week, up to this moment, as in the summary cards.
      last_week AS (
        SELECT s.branch_id, sum(s.total_amount) AS net_sales
        FROM sales s JOIN scope b ON b.id = s.branch_id, day
        WHERE s.status = 'COMPLETED'
          AND s.created_at >= coms_business_day_start(day.today - 7)
          AND s.created_at < least(now() - interval '7 days', coms_business_day_end(day.today - 7))
        GROUP BY s.branch_id
      )
      SELECT b.id AS branch_id, b.branch_name, b.status,
        shift.id AS shift_id, shift.shift_number, shift.cashier_name, shift.opened_at,
        coalesce(p.sales_count, 0) AS sales_count,
        ${money(sql`coalesce(p.net_sales, 0)`)} AS net_sales,
        p.last_sale_at,
        ${money(sql`coalesce(lw.net_sales, 0)`)} AS last_week_net_sales,
        (SELECT r.status FROM daily_branch_reports r, day
          WHERE r.branch_id = b.id AND r.business_date = day.today - 1) AS yesterday_report_status,
        (SELECT count(*)::int FROM sales s, day WHERE s.branch_id = b.id AND s.status = 'COMPLETED'
          AND s.created_at >= coms_business_day_start(day.today - 1)
          AND s.created_at < coms_business_day_end(day.today - 1)) AS yesterday_sales_count
      FROM scope b
      LEFT JOIN per_branch p ON p.branch_id = b.id
      LEFT JOIN last_week lw ON lw.branch_id = b.id
      LEFT JOIN LATERAL (
        SELECT rs.id, rs.shift_number, u.full_name AS cashier_name, rs.opened_at
        FROM register_shifts rs LEFT JOIN coms_auth.users u ON u.id = rs.opened_by_user_id
        WHERE rs.branch_id = b.id AND rs.status = 'OPEN'
        ORDER BY rs.opened_at DESC LIMIT 1
      ) shift ON true
      WHERE b.status = 'active' OR p.branch_id IS NOT NULL OR shift.shift_number IS NOT NULL
      ORDER BY (shift.shift_number IS NOT NULL) DESC, coalesce(p.net_sales, 0) DESC, b.branch_name
    `.execute(this.db);
    return result.rows;
  }

  /**
   * Net sales by Manila clock hour from the business-day start to now, beside
   * the same hours on the same weekday last week.
   */
  async hourly(scope: TodayScope) {
    const result = await sql<{
      hour: string;
      sales_count: number;
      net_sales: string;
      last_week_net_sales: string;
    }>`
      WITH ${this.scope(scope)},
      hours AS (
        SELECT generate_series(
          date_trunc('hour', coms_business_day_start(day.today) AT TIME ZONE 'Asia/Manila'),
          date_trunc('hour', least(now(), coms_business_day_end(day.today) - interval '1 second') AT TIME ZONE 'Asia/Manila'),
          interval '1 hour'
        ) AS local_hour
        FROM day
      ),
      completed AS (
        SELECT date_trunc('hour', s.created_at AT TIME ZONE 'Asia/Manila') AS local_hour,
          s.total_amount
        FROM sales s JOIN scope b ON b.id = s.branch_id, day
        WHERE s.status = 'COMPLETED'
          AND (
            (s.created_at >= coms_business_day_start(day.today)
              AND s.created_at < coms_business_day_end(day.today))
            OR (s.created_at >= coms_business_day_start(day.today - 7)
              AND s.created_at < coms_business_day_end(day.today - 7))
          )
      )
      SELECT to_char(h.local_hour, 'HH24:MI') AS hour,
        (SELECT count(*)::int FROM completed c WHERE c.local_hour = h.local_hour) AS sales_count,
        ${money(sql`(SELECT coalesce(sum(c.total_amount), 0) FROM completed c WHERE c.local_hour = h.local_hour)`)} AS net_sales,
        ${money(sql`(SELECT coalesce(sum(c.total_amount), 0) FROM completed c WHERE c.local_hour = h.local_hour - interval '7 days')`)} AS last_week_net_sales
      FROM hours h
      ORDER BY h.local_hour
    `.execute(this.db);
    return result.rows;
  }

  async lastSevenDays(scope: TodayScope) {
    const result = await sql<{
      date: string;
      sales_count: number;
      net_sales: string;
      food_cost: string;
      gross_profit: string;
    }>`
      WITH ${this.scope(scope)},
      days AS (
        SELECT (day.today - offs)::date AS business_date FROM day, generate_series(0, 6) AS offs
      ),
      completed AS (
        SELECT s.id, s.total_amount, coms_business_date(s.created_at) AS business_date
        FROM sales s JOIN scope b ON b.id = s.branch_id, day
        WHERE s.status = 'COMPLETED'
          AND s.created_at >= coms_business_day_start(day.today - 6)
          AND s.created_at < coms_business_day_end(day.today)
      ),
      per_sale AS (
        SELECT business_date, count(*)::int AS sales_count, sum(total_amount) AS net_sales
        FROM completed GROUP BY business_date
      ),
      per_cost AS (
        SELECT c.business_date, sum(x.quantity_consumed * x.unit_cost) AS food_cost
        FROM completed c JOIN sale_items si ON si.sale_id = c.id
        JOIN sale_item_consumptions x ON x.sale_item_id = si.id
        GROUP BY c.business_date
      )
      SELECT d.business_date::text AS date,
        coalesce(s.sales_count, 0) AS sales_count,
        ${money(sql`coalesce(s.net_sales, 0)`)} AS net_sales,
        ${money(sql`coalesce(c.food_cost, 0)`)} AS food_cost,
        ${money(sql`coalesce(s.net_sales, 0) - round(coalesce(c.food_cost, 0), 2)`)} AS gross_profit
      FROM days d
      LEFT JOIN per_sale s ON s.business_date = d.business_date
      LEFT JOIN per_cost c ON c.business_date = d.business_date
      ORDER BY d.business_date
    `.execute(this.db);
    return result.rows;
  }

  async topProductsToday(scope: TodayScope) {
    const result = await sql<{
      product_id: string;
      name: string;
      quantity: string;
      net_sales: string;
    }>`
      WITH ${this.scope(scope)}
      SELECT si.product_id,
        (array_agg(si.product_name_snapshot ORDER BY s.created_at DESC))[1] AS name,
        trim_scale(sum(si.quantity))::text AS quantity,
        ${money(sql`sum(si.line_total)`)} AS net_sales
      FROM sales s JOIN scope b ON b.id = s.branch_id
      JOIN sale_items si ON si.sale_id = s.id, day
      WHERE s.status = 'COMPLETED'
        AND s.created_at >= coms_business_day_start(day.today)
        AND s.created_at < coms_business_day_end(day.today)
      GROUP BY si.product_id
      ORDER BY sum(si.line_total) DESC, name
      LIMIT 5
    `.execute(this.db);
    return result.rows;
  }

  branchOptions(scope: TodayScope) {
    if (scope !== null && !scope.length) return Promise.resolve([]);
    let query = this.db
      .selectFrom('branches')
      .select(['id', 'branch_name as name', 'status'])
      .orderBy('branch_name')
      .orderBy('id');
    if (scope !== null) query = query.where('id', 'in', scope);
    return query.execute();
  }
}
