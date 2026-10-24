import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { DATABASE } from '../../database/database.module';
import type { DB } from '../../database/db';

@Injectable()
export class ReceiptExportRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DB>) {}

  /** One row per received line, in the order of the given receipts. */
  lines(receiptIds: string[]) {
    if (!receiptIds.length) return Promise.resolve([]);
    return this.db
      .selectFrom('supplier_receipt_items as line')
      .innerJoin('supplier_receipts as r', 'r.id', 'line.supplier_receipt_id')
      .innerJoin('stock_items as si', 'si.id', 'line.stock_item_id')
      .innerJoin(
        'coms_auth.users as recorder',
        'recorder.id',
        'r.recorded_by_user_id',
      )
      .leftJoin('suppliers as s', 's.id', 'r.supplier_id')
      .select([
        sql<string>`to_char(r.received_at, 'YYYY-MM-DD')`.as('received_on'),
        's.supplier_name',
        'r.store_name',
        'r.receipt_number',
        'si.stock_item_name',
        'si.unit',
        sql<string>`line.quantity_received::text`.as('quantity'),
        sql<string>`line.unit_cost::text`.as('unit_cost'),
        sql<string>`(line.quantity_received * line.unit_cost)::text`.as(
          'line_total',
        ),
        'recorder.full_name as recorded_by',
        'r.recorded_at',
      ])
      .where(sql<boolean>`r.id = ANY(${receiptIds}::uuid[])`)
      .orderBy(sql`array_position(${receiptIds}::uuid[], r.id)`)
      .orderBy('si.stock_item_name')
      .execute();
  }
}
