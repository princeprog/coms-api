import { ReceiptPostingRepository } from './receipt-posting.repository';
import { findReceiptDetails } from './receipt-details';
import { containsSearchPattern } from '../../common/utils/list-filters';
import {
  paginatedResult,
  paginationOffset,
} from '../../common/utils/pagination';
import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { DATABASE } from '../../database/database.module';
import type { DB } from '../../database/db';
import type { SupplierReceiptQueryDto } from './dto/supplier-receipt-query.dto';

type ReceiptItemInput = {
  stock_item_id: string;
  quantity_received: string;
  unit_cost: string;
};

type CreateReceiptInput = {
  supplier_id: string;
  received_at: string;
  items: ReceiptItemInput[];
  recorded_by_user_id: string;
  idempotency_key: string;
};

type ReceiptListInput = Pick<
  SupplierReceiptQueryDto,
  | 'page'
  | 'page_size'
  | 'search'
  | 'supplier_id'
  | 'received_from'
  | 'received_to'
  | 'min_cost'
  | 'max_cost'
  | 'sort'
>;

@Injectable()
export class SupplierReceiptsRepository {
  constructor(
    @Inject(DATABASE) private readonly db: Kysely<DB>,
    private readonly posting: ReceiptPostingRepository,
  ) {}

  async list(input: ReceiptListInput) {
    const totalCost = sql<string>`coalesce((select sum(sri.quantity_received * sri.unit_cost) from supplier_receipt_items as sri where sri.supplier_receipt_id = sr.id), 0)`;
    let records = this.db
      .selectFrom('supplier_receipts as sr')
      .where('sr.receipt_kind', '=', 'SUPPLIER_DELIVERY')
      .innerJoin('suppliers as s', 's.id', 'sr.supplier_id')
      .innerJoin(
        'coms_auth.users as recorder',
        'recorder.id',
        'sr.recorded_by_user_id',
      )
      .select([
        'sr.id',
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
        sql<number>`(select count(*)::int from supplier_receipt_items as sri where sri.supplier_receipt_id = sr.id)`.as(
          'item_count',
        ),
      ])
      .limit(input.page_size)
      .offset(paginationOffset(input));
    let count = this.db
      .selectFrom('supplier_receipts as sr')
      .where('sr.receipt_kind', '=', 'SUPPLIER_DELIVERY')
      .innerJoin('suppliers as s', 's.id', 'sr.supplier_id')
      .select((eb) => eb.fn.countAll<number>().as('total'));

    if (input.supplier_id) {
      records = records.where('sr.supplier_id', '=', input.supplier_id);
      count = count.where('sr.supplier_id', '=', input.supplier_id);
    }
    if (input.search) {
      const pattern = containsSearchPattern(input.search);
      records = records.where('s.supplier_name', 'ilike', pattern);
      count = count.where('s.supplier_name', 'ilike', pattern);
    }
    if (input.received_from) {
      records = records.where(
        'sr.received_at',
        '>=',
        sql<Date>`${input.received_from}::date`,
      );
      count = count.where(
        'sr.received_at',
        '>=',
        sql<Date>`${input.received_from}::date`,
      );
    }
    if (input.received_to) {
      records = records.where(
        'sr.received_at',
        '<=',
        sql<Date>`${input.received_to}::date`,
      );
      count = count.where(
        'sr.received_at',
        '<=',
        sql<Date>`${input.received_to}::date`,
      );
    }
    if (input.min_cost) {
      records = records.where(
        totalCost,
        '>=',
        sql<string>`${input.min_cost}::numeric`,
      );
      count = count.where(
        totalCost,
        '>=',
        sql<string>`${input.min_cost}::numeric`,
      );
    }
    if (input.max_cost) {
      records = records.where(
        totalCost,
        '<=',
        sql<string>`${input.max_cost}::numeric`,
      );
      count = count.where(
        totalCost,
        '<=',
        sql<string>`${input.max_cost}::numeric`,
      );
    }
    if (input.sort === 'cost_highest' || input.sort === 'cost_lowest')
      records = records.orderBy(
        totalCost,
        input.sort === 'cost_highest' ? 'desc' : 'asc',
      );
    if (input.sort === 'supplier_asc' || input.sort === 'supplier_desc')
      records = records.orderBy(
        's.supplier_name',
        input.sort === 'supplier_asc' ? 'asc' : 'desc',
      );
    const direction = input.sort === 'oldest' ? 'asc' : 'desc';
    records = records
      .orderBy('sr.received_at', direction)
      .orderBy('sr.created_at', direction)
      .orderBy('sr.id', direction);

    const [items, result] = await Promise.all([
      records.execute(),
      count.executeTakeFirstOrThrow(),
    ]);
    return paginatedResult(items, Number(result.total), input);
  }

  findById(id: string) {
    return findReceiptDetails(this.db, id, 'SUPPLIER_DELIVERY');
  }

  create(input: CreateReceiptInput) {
    return this.posting.create({ ...input, receipt_kind: 'SUPPLIER_DELIVERY' });
  }
}
