import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { DB } from '../src/database/db';

/** Opens a register shift directly so sale tests can focus on sale rules. */
export async function openTestShift(
  db: Kysely<DB>,
  branchId: string,
  userId: string,
  openingFloat = '0',
) {
  const result = await sql<{ id: string }>`
    INSERT INTO register_shifts (
      branch_id, business_date, shift_number, opened_by_user_id, opening_float, open_idempotency_key
    )
    SELECT ${branchId}::uuid, coms_business_date(now()),
      coalesce((SELECT max(shift_number) FROM register_shifts
        WHERE branch_id = ${branchId}::uuid AND business_date = coms_business_date(now())), 0) + 1,
      ${userId}::uuid, ${openingFloat}::numeric, ${randomUUID()}::uuid
    RETURNING id
  `.execute(db);
  return result.rows[0]!.id;
}

/** Removes test shifts and detaches any sales still pointing at them. */
export async function deleteTestShifts(db: Kysely<DB>, branchIds: string[]) {
  if (!branchIds.length) return;
  const shifts = db
    .selectFrom('register_shifts')
    .select('id')
    .where('branch_id', 'in', branchIds);
  await db
    .updateTable('sale_events')
    .set({ refund_shift_id: null })
    .where('refund_shift_id', 'in', shifts)
    .execute();
  await db
    .updateTable('sales')
    .set({ shift_id: null })
    .where('shift_id', 'in', shifts)
    .execute();
  await db
    .deleteFrom('notification_events')
    .where('shift_id', 'in', shifts)
    .execute();
  await db
    .deleteFrom('register_shift_cash_movements')
    .where('shift_id', 'in', shifts)
    .execute();
  await db
    .deleteFrom('register_shifts')
    .where('branch_id', 'in', branchIds)
    .execute();
}
