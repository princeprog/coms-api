import { ConflictException } from '@nestjs/common';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../database/db';

type Executor = Kysely<DB> | Transaction<DB>;

/**
 * Cash or non-cash for a sale aliased "s" joined to payment methods "pm".
 * Shift sales store a snapshot; older sales fall back to their method or label.
 */
export const salePaymentKind = sql<string>`COALESCE(s.payment_kind, pm.kind,
  CASE WHEN lower(s.tender_method) = 'cash' THEN 'CASH' ELSE 'NON_CASH' END)`;

/** Locks the branch's open shift for a sale; only its owner may sell within its business day. */
export async function requireSellingShift(
  transaction: Transaction<DB>,
  branchId: string,
  actorUserId: string,
) {
  const result = await sql<{
    id: string;
    opened_by_user_id: string;
    cashier_name: string;
    day_ended: boolean;
  }>`
    SELECT shift.id, shift.opened_by_user_id,
      coalesce(opener.full_name, 'Another cashier') AS cashier_name,
      coms_business_day_end(shift.business_date) <= now() AS day_ended
    FROM register_shifts AS shift
    LEFT JOIN auth.users AS opener ON opener.id = shift.opened_by_user_id
    WHERE shift.branch_id = ${branchId} AND shift.status = 'OPEN'
    FOR SHARE OF shift
  `.execute(transaction);
  const shift = result.rows[0];
  if (!shift)
    throw new ConflictException({
      code: 'SHIFT_REQUIRED',
      message: 'Open a shift before selling.',
    });
  if (shift.opened_by_user_id !== actorUserId)
    throw new ConflictException({
      code: 'SHIFT_OWNED_BY_OTHER',
      message: `${shift.cashier_name}'s shift is open. Only the cashier who opened it can sell.`,
    });
  if (shift.day_ended)
    throw new ConflictException({
      code: 'SHIFT_DAY_ENDED',
      message:
        'The business day has ended. Close this shift and open a new one to keep selling.',
    });
  return shift.id;
}

/** The branch's open shift, locked so a closing count waits for in-flight refunds. */
export async function lockOpenShift(
  transaction: Transaction<DB>,
  branchId: string,
) {
  const result = await sql<{ id: string }>`
    SELECT id FROM register_shifts
    WHERE branch_id = ${branchId} AND status = 'OPEN'
    FOR SHARE
  `.execute(transaction);
  return result.rows[0]?.id ?? null;
}

/** Shift numbers that still block a daily report for the business date. */
export async function blockingShifts(
  executor: Executor,
  branchId: string,
  businessDate: string,
) {
  const rows = await executor
    .selectFrom('register_shifts')
    .select(['shift_number', 'status'])
    .where('branch_id', '=', branchId)
    .where('business_date', '=', sql<Date>`${businessDate}::date`)
    .where('status', 'in', ['OPEN', 'CLOSED'])
    .orderBy('shift_number')
    .execute();
  return {
    open: rows.filter((r) => r.status === 'OPEN').map((r) => r.shift_number),
    unreviewed: rows
      .filter((r) => r.status === 'CLOSED')
      .map((r) => r.shift_number),
  };
}

export function reportShiftSummaries(
  executor: Executor,
  branchId: string,
  businessDate: string,
) {
  return executor
    .selectFrom('register_shifts as shift')
    .innerJoin('auth.users as opener', 'opener.id', 'shift.opened_by_user_id')
    .select([
      'shift.id',
      'shift.shift_number',
      'shift.status',
      'shift.close_type',
      'opener.full_name as cashier_name',
      'shift.opened_at',
      'shift.closed_at',
      sql<number>`coalesce(shift.sales_count,
        (SELECT count(*)::int FROM sales WHERE sales.shift_id = shift.id))`.as(
        'sales_count',
      ),
      sql<
        string | null
      >`trim_scale(shift.cash_sales_amount - shift.cash_refunds_amount)::text`.as(
        'net_cash_sales',
      ),
      sql<string | null>`trim_scale(shift.non_cash_sales_amount)::text`.as(
        'non_cash_sales',
      ),
      sql<string | null>`trim_scale(shift.cash_difference)::text`.as(
        'cash_difference',
      ),
      sql<string | null>`trim_scale(shift.opening_difference)::text`.as(
        'opening_difference',
      ),
    ])
    .where('shift.branch_id', '=', branchId)
    .where('shift.business_date', '=', sql<Date>`${businessDate}::date`)
    .orderBy('shift.shift_number')
    .execute();
}

export type ShiftTotals = {
  cash_sales_amount: string;
  non_cash_sales_amount: string;
  cash_refunds_amount: string;
  cash_in_amount: string;
  cash_out_amount: string;
  expected_cash: string;
  sales_count: number;
  voids_count: number;
};

/** Expected cash = opening float + cash sales − cash refunds + pay-ins − pay-outs. */
export async function shiftTotals(
  executor: Executor,
  shiftId: string,
): Promise<ShiftTotals> {
  const result = await sql<ShiftTotals>`
    WITH shift AS (
      SELECT opening_float FROM register_shifts WHERE id = ${shiftId}
    ), sold AS (
      SELECT
        coalesce(sum(s.total_amount) FILTER (WHERE s.payment_kind = 'CASH'), 0) AS cash_sales,
        coalesce(sum(s.total_amount) FILTER (
          WHERE s.payment_kind = 'NON_CASH' AND s.status = 'COMPLETED'), 0) AS non_cash_sales,
        count(*)::int AS sales_count
      FROM sales AS s WHERE s.shift_id = ${shiftId}
    ), refunded AS (
      SELECT
        coalesce(sum(s.total_amount) FILTER (WHERE ${salePaymentKind} = 'CASH'), 0) AS cash_refunds,
        count(*)::int AS voids_count
      FROM sale_events AS e
      JOIN sales AS s ON s.id = e.sale_id
      LEFT JOIN payment_methods AS pm ON pm.id = s.payment_method_id
      WHERE e.refund_shift_id = ${shiftId} AND e.event_type = 'VOIDED'
    ), moved AS (
      SELECT
        coalesce(sum(amount) FILTER (WHERE direction = 'IN'), 0) AS cash_in,
        coalesce(sum(amount) FILTER (WHERE direction = 'OUT'), 0) AS cash_out
      FROM register_shift_cash_movements WHERE shift_id = ${shiftId}
    )
    SELECT
      trim_scale(sold.cash_sales)::text AS cash_sales_amount,
      trim_scale(sold.non_cash_sales)::text AS non_cash_sales_amount,
      trim_scale(refunded.cash_refunds)::text AS cash_refunds_amount,
      trim_scale(moved.cash_in)::text AS cash_in_amount,
      trim_scale(moved.cash_out)::text AS cash_out_amount,
      trim_scale(shift.opening_float + sold.cash_sales - refunded.cash_refunds
        + moved.cash_in - moved.cash_out)::text AS expected_cash,
      sold.sales_count,
      refunded.voids_count
    FROM shift, sold, refunded, moved
  `.execute(executor);
  return result.rows[0]!;
}
