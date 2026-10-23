import { sql, type Kysely, type RawBuilder } from 'kysely';
import type { DB } from '../../database/db';

/** Business days of submitted/approved counts behind today's shortage view. */
export const SHORTAGE_WINDOW_DAYS = 7;
/** How far back a branch that sold without a report counts as backlog. */
export const MISSING_REPORT_LOOKBACK_DAYS = 14;
const BACKLOG_LIMIT = 10;
const SHORTAGE_ITEM_LIMIT = 8;

/**
 * Count shortages (physical below expected) from recent submitted or approved
 * reports. Values use the report's saved cost, else the current average cost.
 */
export async function countShortages(
  db: Kysely<DB>,
  scope: RawBuilder<unknown>,
) {
  const lines = sql`
    lines AS (
      SELECT r.id AS report_id, r.branch_id, b.branch_name, r.business_date,
        i.stock_item_id, i.variance_quantity,
        coalesce(i.unit_cost, c.average_unit_cost) AS unit_cost
      FROM daily_branch_reports r
      CROSS JOIN day
      JOIN scope b ON b.id = r.branch_id
      LEFT JOIN daily_branch_report_items i
        ON i.daily_branch_report_id = r.id AND i.variance_quantity IS NOT NULL
      LEFT JOIN stock_item_costs c ON c.stock_item_id = i.stock_item_id
      WHERE r.status IN ('SUBMITTED', 'APPROVED')
        AND r.business_date >= day.today - ${SHORTAGE_WINDOW_DAYS}::int
        AND r.business_date < day.today
    )`;
  const [branches, items] = await Promise.all([
    sql<{
      branch_id: string;
      branch_name: string;
      reports: number;
      short_lines: number;
      uncosted_short_lines: number;
      shortage_value: string | null;
    }>`
      WITH ${scope}, ${lines}
      SELECT branch_id, branch_name,
        count(DISTINCT report_id)::int AS reports,
        count(*) FILTER (WHERE variance_quantity < 0)::int AS short_lines,
        count(*) FILTER (WHERE variance_quantity < 0 AND unit_cost IS NULL)::int
          AS uncosted_short_lines,
        round(coalesce(sum(-variance_quantity * unit_cost)
          FILTER (WHERE variance_quantity < 0), 0), 2)::numeric(14,2)::text
          AS shortage_value
      FROM lines
      GROUP BY branch_id, branch_name
      ORDER BY sum(-variance_quantity * unit_cost)
        FILTER (WHERE variance_quantity < 0) DESC NULLS LAST, branch_name
    `.execute(db),
    sql<{
      branch_id: string;
      branch_name: string;
      stock_item_id: string;
      stock_item_name: string;
      unit: string;
      short_quantity: string;
      shortage_value: string | null;
      times_short: number;
      latest_report_id: string;
      latest_business_date: string;
    }>`
      WITH ${scope}, ${lines}
      SELECT l.branch_id, l.branch_name, l.stock_item_id, si.stock_item_name, si.unit,
        trim_scale(sum(-l.variance_quantity))::text AS short_quantity,
        CASE WHEN bool_and(l.unit_cost IS NOT NULL)
          THEN round(sum(-l.variance_quantity * l.unit_cost), 2)::numeric(14,2)::text
        END AS shortage_value,
        count(DISTINCT l.report_id)::int AS times_short,
        (array_agg(l.report_id ORDER BY l.business_date DESC))[1] AS latest_report_id,
        max(l.business_date)::text AS latest_business_date
      FROM lines l JOIN stock_items si ON si.id = l.stock_item_id
      WHERE l.variance_quantity < 0
      GROUP BY l.branch_id, l.branch_name, l.stock_item_id, si.stock_item_name, si.unit
      ORDER BY sum(-l.variance_quantity * l.unit_cost) DESC NULLS LAST,
        count(DISTINCT l.report_id) DESC, si.stock_item_name, l.branch_name
      LIMIT ${SHORTAGE_ITEM_LIMIT}
    `.execute(db),
  ]);
  return { branches: branches.rows, items: items.rows };
}

/**
 * Reports from before yesterday still in draft or returned, plus recent days a
 * branch sold without starting a report. Today and yesterday are covered by
 * report progress.
 */
export async function reportBacklog(
  db: Kysely<DB>,
  scope: RawBuilder<unknown>,
) {
  const result = await sql<{
    branch_id: string;
    branch_name: string;
    business_date: string;
    report_id: string | null;
    status: 'DRAFT' | 'RETURNED' | 'MISSING';
    days_outstanding: number;
    total: number;
  }>`
    WITH ${scope},
    sales_days AS (
      SELECT s.branch_id, coms_business_date(s.created_at) AS business_date
      FROM sales s CROSS JOIN day
      JOIN scope b ON b.id = s.branch_id AND b.status = 'active'
      WHERE s.status = 'COMPLETED'
        AND s.created_at >= coms_business_day_start(day.today - ${MISSING_REPORT_LOOKBACK_DAYS}::int)
        AND s.created_at < coms_business_day_end(day.today - 2)
      GROUP BY 1, 2
    ),
    outstanding AS (
      SELECT r.branch_id, r.business_date, r.id AS report_id, r.status
      FROM daily_branch_reports r CROSS JOIN day
      JOIN scope b ON b.id = r.branch_id
      WHERE r.status IN ('DRAFT', 'RETURNED') AND r.business_date < day.today - 1
      UNION ALL
      SELECT sd.branch_id, sd.business_date, NULL, 'MISSING'
      FROM sales_days sd
      WHERE NOT EXISTS (SELECT 1 FROM daily_branch_reports r
        WHERE r.branch_id = sd.branch_id AND r.business_date = sd.business_date)
    )
    SELECT o.branch_id, b.branch_name, o.business_date::text AS business_date,
      o.report_id, o.status, (day.today - o.business_date)::int AS days_outstanding,
      count(*) OVER ()::int AS total
    FROM outstanding o CROSS JOIN day JOIN scope b ON b.id = o.branch_id
    ORDER BY o.business_date, b.branch_name, o.branch_id
    LIMIT ${BACKLOG_LIMIT}
  `.execute(db);
  return {
    total: result.rows[0]?.total ?? 0,
    items: result.rows.map(({ total: _total, ...row }) => row),
  };
}
