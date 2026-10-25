import { sql, type Kysely, type RawBuilder } from 'kysely';
import type { DB } from '../../database/db';

export type ReportProgress = {
  branch_id: string;
  period: 'today' | 'yesterday';
  business_date: string;
  report_id: string | null;
  status: string;
  total_items: number | null;
  counted_items: number | null;
  open_shifts: number;
  unreviewed_shifts: number;
  pending_deliveries: number;
  counts_awaiting_review: number;
  day_ended: boolean;
  had_sales: boolean;
};

/** One bulk query; saved membership is authoritative, including empty reports. */
export async function reportProgress(
  db: Kysely<DB>,
  scope: RawBuilder<unknown>,
) {
  const result = await sql<ReportProgress>`
    WITH ${scope}, dates AS (
      SELECT today AS date, 'today' AS period FROM day
      UNION ALL SELECT today - 1, 'yesterday' FROM day
    ), reports AS (
      SELECT r.* FROM daily_branch_reports r JOIN scope b ON b.id = r.branch_id
      JOIN dates d ON d.date = r.business_date
    ), counts AS (
      SELECT i.daily_branch_report_id, count(*)::int AS total,
        count(i.physical_closing_quantity)::int AS counted
      FROM daily_branch_report_items i JOIN reports r ON r.id = i.daily_branch_report_id
      GROUP BY i.daily_branch_report_id
    ), shifts AS (
      SELECT rs.branch_id, rs.business_date,
        count(*) FILTER (WHERE rs.status = 'OPEN')::int AS open,
        count(*) FILTER (WHERE rs.status = 'CLOSED')::int AS unreviewed
      FROM register_shifts rs JOIN scope b ON b.id = rs.branch_id
      JOIN dates d ON d.date = rs.business_date
      GROUP BY rs.branch_id, rs.business_date
    ), deliveries AS (
      SELECT d.branch_id, dates.date, count(*)::int AS pending
      FROM dispatches d JOIN scope b ON b.id = d.branch_id
      JOIN dates ON d.dispatched_at < coms_business_day_end(dates.date)
      WHERE d.counted_at IS NULL AND d.status IN ('IN_TRANSIT', 'PARTIALLY_RECEIVED')
      GROUP BY d.branch_id, dates.date
    ), late_counts AS (
      SELECT d.branch_id, dates.date, count(*)::int AS pending
      FROM dispatch_late_counts lc JOIN dispatches d ON d.id = lc.dispatch_id
      JOIN scope b ON b.id = d.branch_id JOIN dates ON lc.delivery_date <= dates.date
      WHERE lc.status = 'PENDING' GROUP BY d.branch_id, dates.date
    ), sales_days AS (
      SELECT s.branch_id, dates.date FROM sales s JOIN scope b ON b.id = s.branch_id
      JOIN dates ON s.occurred_at >= coms_business_day_start(dates.date)
        AND s.occurred_at < coms_business_day_end(dates.date)
      WHERE s.status = 'COMPLETED' GROUP BY s.branch_id, dates.date
    )
    SELECT b.id AS branch_id, dates.period, dates.date::text AS business_date,
      r.id AS report_id, coalesce(r.status, 'MISSING') AS status,
      CASE WHEN r.id IS NULL THEN NULL ELSE coalesce(c.total, 0) END AS total_items,
      CASE WHEN r.id IS NULL THEN NULL ELSE coalesce(c.counted, 0) END AS counted_items,
      coalesce(s.open, 0) AS open_shifts, coalesce(s.unreviewed, 0) AS unreviewed_shifts,
      coalesce(d.pending, 0) AS pending_deliveries,
      coalesce(lc.pending, 0) AS counts_awaiting_review,
      now() >= coms_business_day_end(dates.date) AS day_ended,
      sd.branch_id IS NOT NULL AS had_sales
    FROM scope b CROSS JOIN dates
    LEFT JOIN reports r ON r.branch_id = b.id AND r.business_date = dates.date
    LEFT JOIN counts c ON c.daily_branch_report_id = r.id
    LEFT JOIN shifts s ON s.branch_id = b.id AND s.business_date = dates.date
    LEFT JOIN deliveries d ON d.branch_id = b.id AND d.date = dates.date
    LEFT JOIN late_counts lc ON lc.branch_id = b.id AND lc.date = dates.date
    LEFT JOIN sales_days sd ON sd.branch_id = b.id AND sd.date = dates.date
    WHERE b.status = 'active' OR r.id IS NOT NULL OR sd.branch_id IS NOT NULL
    ORDER BY b.id, dates.date DESC
  `.execute(db);
  return result.rows;
}
