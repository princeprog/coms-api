import { sql, type Transaction } from 'kysely';
import type { DB } from '../../database/db';

// Weighted average against the commissary stock already on hand (negative stock
// counts as none). Call before the receipt quantity is added to the balance.
export async function applyReceiptCost(
  tx: Transaction<DB>,
  input: {
    stockItemId: string;
    quantity: string;
    unitCost: string;
    receivedAt: string;
    actorUserId: string;
  },
) {
  const onHand = sql`greatest(coalesce((SELECT quantity_on_hand FROM commissary_inventory WHERE stock_item_id = ${input.stockItemId}::uuid), 0), 0)`;
  await sql`
    INSERT INTO stock_item_costs AS c (
      stock_item_id, average_unit_cost, last_unit_cost, last_received_at,
      cost_source, updated_by_user_id, updated_at
    ) VALUES (
      ${input.stockItemId}::uuid, ${input.unitCost}::numeric, ${input.unitCost}::numeric,
      ${input.receivedAt}::timestamptz, 'RECEIPT', ${input.actorUserId}::uuid, now()
    )
    ON CONFLICT (stock_item_id) DO UPDATE SET
      average_unit_cost = round(coalesce(
        (${onHand} * c.average_unit_cost + ${input.quantity}::numeric * ${input.unitCost}::numeric)
          / nullif(${onHand} + ${input.quantity}::numeric, 0),
        ${input.unitCost}::numeric), 6),
      last_unit_cost = excluded.last_unit_cost,
      last_received_at = excluded.last_received_at,
      cost_source = 'RECEIPT',
      updated_by_user_id = excluded.updated_by_user_id,
      updated_at = now()
  `.execute(tx);
}

export async function currentUnitCosts(
  tx: Transaction<DB>,
  stockItemIds: string[],
): Promise<Map<string, string>> {
  if (!stockItemIds.length) return new Map();
  const rows = await tx
    .selectFrom('stock_item_costs')
    .select(['stock_item_id', 'average_unit_cost'])
    .where('stock_item_id', 'in', stockItemIds)
    .execute();
  return new Map(rows.map((r) => [r.stock_item_id, r.average_unit_cost]));
}
