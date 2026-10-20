import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../database/db';
import type { ReceiptKind } from './receipt-posting.repository';
export async function findReceiptDetails(
  executor: Kysely<DB> | Transaction<DB>,
  id: string,
  kind: ReceiptKind,
) {
  const receipt = await executor
    .selectFrom('supplier_receipts as sr')
    .leftJoin('suppliers as s', 's.id', 'sr.supplier_id')
    .innerJoin(
      'auth.users as recorder',
      'recorder.id',
      'sr.recorded_by_user_id',
    )
    .select([
      'sr.id',
      'sr.receipt_kind',
      'sr.store_name',
      'sr.receipt_number',
      'sr.notes',
      'sr.supplier_id',
      's.supplier_name',
      sql<string>`to_char(sr.received_at, 'YYYY-MM-DD')`.as('received_at'),
      'sr.idempotency_key',
      'sr.recorded_by_user_id',
      'recorder.full_name as recorded_by_name',
      'sr.recorded_at',
      'sr.created_at',
      'sr.updated_at',
      sql<string>`coalesce((select sum(sri.quantity_received * sri.unit_cost)::text from supplier_receipt_items as sri where sri.supplier_receipt_id = sr.id), '0')`.as(
        'total_cost',
      ),
    ])
    .where('sr.id', '=', id)
    .where('sr.receipt_kind', '=', kind)
    .executeTakeFirst();
  if (!receipt) return undefined;

  const items = await executor
    .selectFrom('supplier_receipt_items as sri')
    .innerJoin('stock_items as si', 'si.id', 'sri.stock_item_id')
    .select([
      'sri.id',
      'sri.stock_item_id',
      'si.stock_item_name',
      'si.unit',
      sql<string>`sri.quantity_received::text`.as('quantity_received'),
      sql<string>`sri.unit_cost::text`.as('unit_cost'),
      sql<string>`(sri.quantity_received * sri.unit_cost)::text`.as(
        'line_total',
      ),
    ])
    .where('sri.supplier_receipt_id', '=', id)
    .orderBy('si.stock_item_name')
    .orderBy('sri.id')
    .execute();

  return { ...receipt, items };
}
