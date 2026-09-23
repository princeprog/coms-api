import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { sql, type Kysely, type Transaction } from 'kysely';
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
  created_by_user_id: string;
  idempotency_key: string;
};

type ReceiptListInput = Pick<
  SupplierReceiptQueryDto,
  'page' | 'page_size' | 'search' | 'supplier_id' | 'status'
>;

type DbExecutor = Kysely<DB> | Transaction<DB>;

@Injectable()
export class SupplierReceiptsRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DB>) {}

  async list(input: ReceiptListInput) {
    let records = this.db
      .selectFrom('supplier_receipts as sr')
      .innerJoin('suppliers as s', 's.id', 'sr.supplier_id')
      .select([
        'sr.id',
        'sr.supplier_id',
        's.supplier_name',
        sql<string>`to_char(sr.received_at, 'YYYY-MM-DD')`.as('received_at'),
        'sr.status',
        'sr.created_by_user_id',
        'sr.posted_by_user_id',
        'sr.posted_at',
        'sr.created_at',
        'sr.updated_at',
        sql<string>`coalesce((select sum(sri.quantity_received * sri.unit_cost)::text from supplier_receipt_items as sri where sri.supplier_receipt_id = sr.id), '0')`.as(
          'total_cost',
        ),
        sql<number>`(select count(*)::int from supplier_receipt_items as sri where sri.supplier_receipt_id = sr.id)`.as(
          'item_count',
        ),
      ])
      .orderBy('sr.received_at', 'desc')
      .orderBy('sr.created_at', 'desc')
      .orderBy('sr.id', 'desc')
      .limit(input.page_size)
      .offset((input.page - 1) * input.page_size);
    let count = this.db
      .selectFrom('supplier_receipts as sr')
      .innerJoin('suppliers as s', 's.id', 'sr.supplier_id')
      .select((eb) => eb.fn.countAll<number>().as('total'));

    if (input.supplier_id) {
      records = records.where('sr.supplier_id', '=', input.supplier_id);
      count = count.where('sr.supplier_id', '=', input.supplier_id);
    }
    if (input.status) {
      records = records.where('sr.status', '=', input.status);
      count = count.where('sr.status', '=', input.status);
    }
    if (input.search) {
      const pattern = this.searchPattern(input.search);
      records = records.where('s.supplier_name', 'ilike', pattern);
      count = count.where('s.supplier_name', 'ilike', pattern);
    }

    const [items, result] = await Promise.all([
      records.execute(),
      count.executeTakeFirstOrThrow(),
    ]);
    return {
      items,
      total: Number(result.total),
      page: input.page,
      page_size: input.page_size,
    };
  }

  findById(id: string) {
    return this.findDetails(this.db, id);
  }

  async create(input: CreateReceiptInput) {
    try {
      return await this.db.transaction().execute(async (transaction) => {
        const existing = await this.findReceiptByIdempotencyKey(
          transaction,
          input.idempotency_key,
        );
        if (existing) return this.returnForRetry(transaction, existing, input);

        const supplier = await transaction
          .selectFrom('suppliers')
          .select('id')
          .where('id', '=', input.supplier_id)
          .where('is_active', '=', true)
          .forUpdate()
          .executeTakeFirst();
        if (!supplier) throw new NotFoundException('Active supplier not found');

        const stockItemIds = [
          ...new Set(input.items.map((item) => item.stock_item_id)),
        ];
        const activeStockItems = await transaction
          .selectFrom('stock_items')
          .select('id')
          .where('id', 'in', stockItemIds)
          .where('is_active', '=', true)
          .orderBy('id')
          .forUpdate()
          .execute();
        if (activeStockItems.length !== stockItemIds.length)
          throw new NotFoundException(
            'One or more active stock items were not found',
          );

        const receipt = await transaction
          .insertInto('supplier_receipts')
          .values({
            supplier_id: input.supplier_id,
            received_at: input.received_at,
            idempotency_key: input.idempotency_key,
            created_by_user_id: input.created_by_user_id,
          })
          .returning('id')
          .executeTakeFirstOrThrow();

        await transaction
          .insertInto('supplier_receipt_items')
          .values(
            input.items.map((item) => ({
              supplier_receipt_id: receipt.id,
              stock_item_id: item.stock_item_id,
              quantity_received: item.quantity_received,
              unit_cost: item.unit_cost,
            })),
          )
          .execute();

        const detail = await this.findDetails(transaction, receipt.id);
        if (!detail)
          throw new Error('Created supplier receipt could not be loaded');
        return detail;
      });
    } catch (error) {
      if (!this.isUniqueViolation(error)) throw error;

      const existing = await this.findReceiptByIdempotencyKey(
        this.db,
        input.idempotency_key,
      );
      if (!existing) throw error;
      return this.returnForRetry(this.db, existing, input);
    }
  }

  async post(id: string, actorUserId: string) {
    return this.db.transaction().execute(async (transaction) => {
      const receipt = await transaction
        .selectFrom('supplier_receipts')
        .select(['id', 'status'])
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!receipt) throw new NotFoundException('Supplier receipt not found');
      if (receipt.status === 'POSTED') {
        const detail = await this.findDetails(transaction, id);
        if (!detail) throw new NotFoundException('Supplier receipt not found');
        return detail;
      }
      if (receipt.status !== 'DRAFT')
        throw new ConflictException(
          'Supplier receipt cannot be posted in its current state',
        );

      const items = await transaction
        .selectFrom('supplier_receipt_items')
        .select(['id', 'stock_item_id', 'quantity_received'])
        .where('supplier_receipt_id', '=', id)
        .orderBy('stock_item_id')
        .orderBy('id')
        .execute();
      if (!items.length)
        throw new BadRequestException('Supplier receipt has no items to post');

      for (const item of items) {
        await transaction
          .insertInto('commissary_inventory')
          .values({ stock_item_id: item.stock_item_id, quantity_on_hand: '0' })
          .onConflict((conflict) =>
            conflict.column('stock_item_id').doNothing(),
          )
          .execute();

        await transaction
          .updateTable('commissary_inventory')
          .set({
            quantity_on_hand: sql`quantity_on_hand + ${item.quantity_received}`,
            updated_at: sql<Date>`now()`,
          })
          .where('stock_item_id', '=', item.stock_item_id)
          .executeTakeFirstOrThrow();

        await transaction
          .insertInto('inventory_movements')
          .values({
            inventory_scope: 'COMMISSARY',
            branch_id: null,
            stock_item_id: item.stock_item_id,
            movement_type: 'RECEIPT',
            quantity_delta: item.quantity_received,
            reason: `Supplier receipt ${id}`,
            actor_user_id: actorUserId,
            idempotency_key: null,
            supplier_receipt_item_id: item.id,
          })
          .execute();
      }

      await transaction
        .updateTable('supplier_receipts')
        .set({
          status: 'POSTED',
          posted_by_user_id: actorUserId,
          posted_at: sql<Date>`now()`,
          updated_at: sql<Date>`now()`,
        })
        .where('id', '=', id)
        .where('status', '=', 'DRAFT')
        .executeTakeFirstOrThrow();

      const detail = await this.findDetails(transaction, id);
      if (!detail) throw new NotFoundException('Supplier receipt not found');
      return detail;
    });
  }

  private async findDetails(executor: DbExecutor, id: string) {
    const receipt = await executor
      .selectFrom('supplier_receipts as sr')
      .innerJoin('suppliers as s', 's.id', 'sr.supplier_id')
      .select([
        'sr.id',
        'sr.supplier_id',
        's.supplier_name',
        sql<string>`to_char(sr.received_at, 'YYYY-MM-DD')`.as('received_at'),
        'sr.status',
        'sr.idempotency_key',
        'sr.created_by_user_id',
        'sr.posted_by_user_id',
        'sr.posted_at',
        'sr.created_at',
        'sr.updated_at',
        sql<string>`coalesce((select sum(sri.quantity_received * sri.unit_cost)::text from supplier_receipt_items as sri where sri.supplier_receipt_id = sr.id), '0')`.as(
          'total_cost',
        ),
      ])
      .where('sr.id', '=', id)
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

  private async findReceiptByIdempotencyKey(executor: DbExecutor, key: string) {
    return executor
      .selectFrom('supplier_receipts')
      .select([
        'id',
        'supplier_id',
        sql<string>`to_char(received_at, 'YYYY-MM-DD')`.as('received_at'),
        'created_by_user_id',
      ])
      .where('idempotency_key', '=', key)
      .executeTakeFirst();
  }

  private async returnForRetry(
    executor: DbExecutor,
    existing: {
      id: string;
      supplier_id: string;
      received_at: string;
      created_by_user_id: string;
    },
    input: CreateReceiptInput,
  ) {
    const existingItems = await executor
      .selectFrom('supplier_receipt_items')
      .select(['stock_item_id', 'quantity_received', 'unit_cost'])
      .where('supplier_receipt_id', '=', existing.id)
      .execute();
    const sameRequest =
      existing.supplier_id === input.supplier_id &&
      existing.received_at === input.received_at &&
      existing.created_by_user_id === input.created_by_user_id &&
      this.itemFingerprint(existingItems) === this.itemFingerprint(input.items);
    if (!sameRequest)
      throw new ConflictException(
        'Idempotency key was already used for another supplier receipt',
      );

    const detail = await this.findDetails(executor, existing.id);
    if (!detail) throw new NotFoundException('Supplier receipt not found');
    return detail;
  }

  private itemFingerprint(
    items: Array<{
      stock_item_id: string;
      quantity_received: string | number;
      unit_cost: string | number;
    }>,
  ) {
    return items
      .map((item) =>
        [
          item.stock_item_id,
          this.normalizeDecimal(item.quantity_received),
          this.normalizeDecimal(item.unit_cost),
        ].join(':'),
      )
      .sort()
      .join('|');
  }

  private normalizeDecimal(value: string | number) {
    const decimal = String(value);
    const [wholePart, fractionPart = ''] = decimal.split('.');
    const whole = wholePart.replace(/^0+(?=\d)/, '');
    const fraction = fractionPart.replace(/0+$/, '');
    return `${whole}${fraction ? `.${fraction}` : ''}`;
  }

  private searchPattern(search: string) {
    return `%${search.replace(/[\\%_]/g, '\\$&')}%`;
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === '23505'
    );
  }
}
