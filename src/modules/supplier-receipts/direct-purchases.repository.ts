import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { DATABASE } from '../../database/database.module';
import type { DB } from '../../database/db';
import { containsSearchPattern } from '../../common/utils/list-filters';
import {
  paginatedResult,
  paginationOffset,
} from '../../common/utils/pagination';
import { findReceiptDetails } from './receipt-details';
import type { DirectPurchaseQueryDto } from './dto/direct-purchase.dto';
@Injectable()
export class DirectPurchasesRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DB>) {}
  findById(id: string) {
    return findReceiptDetails(this.db, id, 'DIRECT_PURCHASE');
  }
  async list(input: DirectPurchaseQueryDto) {
    let query = this.db
      .selectFrom('supplier_receipts as r')
      .innerJoin('coms_auth.users as u', 'u.id', 'r.recorded_by_user_id')
      .where('r.receipt_kind', '=', 'DIRECT_PURCHASE');
    if (input.search?.trim()) {
      const pattern = containsSearchPattern(input.search.trim());
      query = query.where((eb) =>
        eb.or([
          eb('r.store_name', 'ilike', pattern),
          eb('r.receipt_number', 'ilike', pattern),
        ]),
      );
    }
    if (input.purchased_from)
      query = query.where(
        'r.received_at',
        '>=',
        sql<Date>`${input.purchased_from}::date`,
      );
    if (input.purchased_to)
      query = query.where(
        'r.received_at',
        '<=',
        sql<Date>`${input.purchased_to}::date`,
      );
    const [items, count] = await Promise.all([
      query
        .select([
          'r.id',
          'r.store_name',
          'r.receipt_number',
          'r.recorded_at',
          'u.full_name as recorded_by_name',
          sql<string>`to_char(r.received_at,'YYYY-MM-DD')`.as('purchase_date'),
          sql<string>`(SELECT coalesce(sum(i.quantity_received*i.unit_cost),0)::text FROM supplier_receipt_items i WHERE i.supplier_receipt_id=r.id)`.as(
            'total_cost',
          ),
          sql<number>`(SELECT count(*)::int FROM supplier_receipt_items i WHERE i.supplier_receipt_id=r.id)`.as(
            'item_count',
          ),
        ])
        .orderBy('r.received_at', input.sort === 'oldest' ? 'asc' : 'desc')
        .orderBy('r.created_at', input.sort === 'oldest' ? 'asc' : 'desc')
        .orderBy('r.id')
        .limit(input.page_size)
        .offset(paginationOffset(input))
        .execute(),
      query
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .executeTakeFirstOrThrow(),
    ]);
    return paginatedResult(items, Number(count.count), input);
  }
}
