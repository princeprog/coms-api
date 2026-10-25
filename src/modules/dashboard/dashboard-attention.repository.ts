import { sql, type Kysely, type RawBuilder } from 'kysely';
import type { DB } from '../../database/db';
import { receivingStatus } from '../dispatches/receiving-policy';
import { onTheWaySql } from '../inventory/stock-position';
import { scheduledShiftsSql } from '../schedules/schedule-occurrences';
import type { AttentionKey } from './dashboard-today.repository';

/** A scheduled shift may start this late before its closed register is flagged. */
const REGISTER_GRACE_MINUTES = 15;

export type AttentionSummary = {
  key: AttentionKey;
  count: number;
  branch_count: number;
  oldest_at: Date | null;
  amount: string | null;
  example: {
    record_id: string;
    branch_id: string | null;
    branch_name: string | null;
    label: string | null;
    quantity: string | null;
    unit: string | null;
  };
};

/** Counts and one oldest example share the same scoped set, without per-row requests. */
export async function attentionSummary(
  db: Kysely<DB>,
  scope: RawBuilder<unknown>,
) {
  const result = await sql<AttentionSummary>`
    WITH ${scope}, receiving AS (
      SELECT d.*, b.branch_name, ${receivingStatus} AS state,
        (SELECT min(lc.created_at) FROM dispatch_late_counts lc
          WHERE lc.dispatch_id = d.id AND lc.status = 'PENDING') AS pending_count_at
      FROM dispatches d JOIN scope b ON b.id = d.branch_id
    ), events (key, branch_id, branch_name, record_id, label, occurred_at, quantity, unit, amount) AS (
      SELECT CASE state WHEN 'OVERDUE' THEN 'deliveries_overdue'
        WHEN 'REVIEW' THEN 'late_counts_to_review' ELSE 'deliveries_in_transit' END,
        branch_id, branch_name, id, NULL::text,
        CASE WHEN state = 'OVERDUE' THEN receive_by
          WHEN state = 'REVIEW' THEN pending_count_at ELSE dispatched_at END,
        NULL::numeric, NULL::text, NULL::numeric
      FROM receiving WHERE state IN ('OVERDUE', 'REVIEW', 'AWAITING_COUNT')
      UNION ALL
      SELECT 'dispatches_draft', branch_id, branch_name, id, NULL, created_at, NULL, NULL, NULL
      FROM receiving WHERE status = 'DRAFT'
      UNION ALL
      SELECT 'open_discrepancies', d.branch_id, b.branch_name, d.id, NULL, dd.reported_at, NULL, NULL, NULL
      FROM dispatch_discrepancies dd JOIN dispatches d ON d.id = dd.dispatch_id
      JOIN scope b ON b.id = d.branch_id WHERE dd.status = 'OPEN'
      UNION ALL
      SELECT 'shifts_to_review', rs.branch_id, b.branch_name, rs.id,
        'Shift ' || rs.shift_number, rs.closed_at, NULL, NULL, NULL
      FROM register_shifts rs JOIN scope b ON b.id = rs.branch_id WHERE rs.status = 'CLOSED'
      UNION ALL
      SELECT 'shifts_open_past_day', rs.branch_id, b.branch_name, rs.id,
        'Shift ' || rs.shift_number, rs.opened_at, NULL, NULL, NULL
      FROM register_shifts rs JOIN scope b ON b.id = rs.branch_id, day
      WHERE rs.status = 'OPEN' AND rs.business_date < day.today
      UNION ALL
      SELECT 'cash_shortages', rs.branch_id, b.branch_name, rs.id,
        'Shift ' || rs.shift_number, rs.closed_at, NULL, NULL, -rs.cash_difference
      FROM register_shifts rs JOIN scope b ON b.id = rs.branch_id, day
      WHERE rs.status IN ('CLOSED','REVIEWED') AND rs.cash_difference < 0
        AND rs.business_date > day.today - 7
      UNION ALL
      SELECT 'stock_below_zero', bi.branch_id, b.branch_name, si.id,
        si.stock_item_name, NULL, bi.quantity_on_hand, si.unit, NULL
      FROM branch_inventory bi JOIN scope b ON b.id = bi.branch_id
      JOIN stock_items si ON si.id = bi.stock_item_id WHERE bi.quantity_on_hand < 0
      UNION ALL
      SELECT 'commissary_stock_below_zero', NULL, NULL, si.id,
        si.stock_item_name, NULL, ci.quantity_on_hand, si.unit, NULL
      FROM commissary_inventory ci JOIN stock_items si ON si.id = ci.stock_item_id
      WHERE ci.quantity_on_hand < 0
      UNION ALL
      SELECT 'branch_stock_low', sl.branch_id, b.branch_name, si.id,
        si.stock_item_name, NULL, coalesce(bi.quantity_on_hand, 0), si.unit, NULL
      FROM stock_levels sl JOIN scope b ON b.id = sl.branch_id AND b.status = 'active'
      JOIN stock_items si ON si.id = sl.stock_item_id AND si.is_active
      LEFT JOIN branch_inventory bi ON bi.branch_id = sl.branch_id AND bi.stock_item_id = sl.stock_item_id
      WHERE sl.inventory_scope = 'BRANCH' AND coalesce(bi.quantity_on_hand, 0)
        + ${onTheWaySql(sql.ref('sl.branch_id'), sql.ref('sl.stock_item_id'))} <= sl.reorder_level
      UNION ALL
      SELECT 'commissary_stock_low', NULL, NULL, si.id, si.stock_item_name, NULL,
        coalesce(ci.quantity_on_hand, 0), si.unit, NULL
      FROM stock_levels sl JOIN stock_items si ON si.id = sl.stock_item_id AND si.is_active
      LEFT JOIN commissary_inventory ci ON ci.stock_item_id = sl.stock_item_id
      WHERE sl.inventory_scope = 'COMMISSARY' AND coalesce(ci.quantity_on_hand, 0) <= sl.reorder_level
      UNION ALL
      SELECT CASE r.status WHEN 'SUBMITTED' THEN 'reports_to_review' ELSE 'reports_returned' END,
        r.branch_id, b.branch_name, r.id, r.business_date::text,
        CASE WHEN r.status = 'SUBMITTED' THEN r.submitted_at ELSE r.reviewed_at END,
        NULL, NULL, NULL
      FROM daily_branch_reports r JOIN scope b ON b.id = r.branch_id
      WHERE r.status IN ('SUBMITTED', 'RETURNED')
      UNION ALL
      SELECT 'reports_missing', b.id, b.branch_name, b.id, (day.today - 1)::text,
        coms_business_day_end(day.today - 1), NULL, NULL, NULL
      FROM scope b, day WHERE b.status = 'active'
        AND EXISTS (SELECT 1 FROM sales s WHERE s.branch_id = b.id AND s.status = 'COMPLETED'
          AND s.created_at >= coms_business_day_start(day.today - 1)
          AND s.created_at < coms_business_day_end(day.today - 1))
        AND NOT EXISTS (SELECT 1 FROM daily_branch_reports r
          WHERE r.branch_id = b.id AND r.business_date = day.today - 1)
      UNION ALL
      SELECT * FROM (
        SELECT DISTINCT ON (o.branch_id) 'register_not_opened', o.branch_id, b.branch_name,
          o.template_id, o.template_name || ' ' || o.start_time || '–' || o.end_time,
          o.starts_at, NULL::numeric, NULL::text, NULL::numeric
        FROM (${scheduledShiftsSql({ from: sql`(SELECT today FROM day)`, to: sql`(SELECT today FROM day)` })}) AS o
        JOIN scope b ON b.id = o.branch_id AND b.status = 'active'
        WHERE o.starts_at + make_interval(mins => ${REGISTER_GRACE_MINUTES}) <= now()
          AND now() < o.ends_at
          AND NOT EXISTS (SELECT 1 FROM register_shifts rs
            WHERE rs.branch_id = o.branch_id AND rs.status = 'OPEN')
        ORDER BY o.branch_id, o.starts_at
      ) AS not_opened
      UNION ALL
      SELECT 'register_opened_unscheduled', rs.branch_id, b.branch_name, rs.id,
        u.full_name, rs.opened_at, NULL, NULL, NULL
      FROM register_shifts rs JOIN scope b ON b.id = rs.branch_id
      JOIN coms_auth.users u ON u.id = rs.opened_by_user_id, day
      WHERE rs.business_date = day.today AND rs.schedule_status = 'UNSCHEDULED'
    ), ranked AS (
      SELECT *, row_number() OVER (PARTITION BY key ORDER BY occurred_at NULLS LAST, label, record_id, branch_id) AS position
      FROM events
    )
    SELECT key, count(*)::int AS count, count(DISTINCT branch_id)::int AS branch_count,
      min(occurred_at) AS oldest_at, round(sum(amount), 2)::numeric(14,2)::text AS amount,
      (jsonb_agg(jsonb_build_object('record_id', record_id, 'branch_id', branch_id,
        'branch_name', branch_name, 'label', label, 'quantity', trim_scale(quantity)::text, 'unit', unit))
        FILTER (WHERE position = 1))->0 AS example
    FROM ranked GROUP BY key
  `.execute(db);
  return result.rows;
}
