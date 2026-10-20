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
import { findReceiptDetails } from './receipt-details';
export type ReceiptKind = 'SUPPLIER_DELIVERY' | 'DIRECT_PURCHASE';
export type CreateReceiptInput = {
  receipt_kind: ReceiptKind;
  supplier_id: string | null;
  received_at: string;
  store_name?: string | null;
  receipt_number?: string | null;
  notes?: string | null;
  items: {
    stock_item_id: string;
    quantity_received: string;
    unit_cost: string;
  }[];
  recorded_by_user_id: string;
  idempotency_key: string;
};
type DbExecutor = Kysely<DB> | Transaction<DB>;
@Injectable()
export class ReceiptPostingRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DB>) {}
  async create(input: CreateReceiptInput) {
    try {
      return await this.db.transaction().execute(async (transaction) => {
        const existing = await this.findReceiptByIdempotencyKey(
          transaction,
          input.idempotency_key,
        );
        if (existing) return this.returnForRetry(transaction, existing, input);

        if (input.receipt_kind === 'SUPPLIER_DELIVERY') {
          const supplier = await transaction
            .selectFrom('suppliers')
            .select('id')
            .where('id', '=', input.supplier_id!)
            .where('is_active', '=', true)
            .forUpdate()
            .executeTakeFirst();
          if (!supplier)
            throw new NotFoundException('Active supplier not found');
        }

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

        if (stockItemIds.length !== input.items.length)
          throw new BadRequestException(
            'A stock item may appear only once in a supplier delivery',
          );

        const receipt = await transaction
          .insertInto('supplier_receipts')
          .values({
            supplier_id: input.supplier_id,
            receipt_kind: input.receipt_kind,
            store_name: input.store_name ?? null,
            receipt_number: input.receipt_number ?? null,
            notes: input.notes ?? null,
            received_at: input.received_at,
            idempotency_key: input.idempotency_key,
            created_by_user_id: input.recorded_by_user_id,
            recorded_by_user_id: input.recorded_by_user_id,
            recorded_at: sql<Date>`now()`,
          })
          .returning('id')
          .executeTakeFirstOrThrow();

        const receiptItems = await transaction
          .insertInto('supplier_receipt_items')
          .values(
            input.items.map((item) => ({
              supplier_receipt_id: receipt.id,
              stock_item_id: item.stock_item_id,
              quantity_received: item.quantity_received,
              unit_cost: item.unit_cost,
            })),
          )
          .returning(['id', 'stock_item_id', 'quantity_received'])
          .execute();

        await transaction
          .insertInto('commissary_inventory')
          .values(
            stockItemIds
              .slice()
              .sort()
              .map((stock_item_id) => ({
                stock_item_id,
                quantity_on_hand: '0',
              })),
          )
          .onConflict((conflict) =>
            conflict.column('stock_item_id').doNothing(),
          )
          .execute();
        await transaction
          .selectFrom('commissary_inventory')
          .select('stock_item_id')
          .where('stock_item_id', 'in', stockItemIds)
          .orderBy('stock_item_id')
          .forUpdate()
          .execute();
        for (const item of receiptItems) {
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
              reason:
                input.receipt_kind === 'DIRECT_PURCHASE'
                  ? 'Purchase received'
                  : `Supplier receipt ${receipt.id}`,
              actor_user_id: input.recorded_by_user_id,
              idempotency_key: null,
              supplier_receipt_item_id: item.id,
            })
            .execute();
        }

        const detail = await findReceiptDetails(
          transaction,
          receipt.id,
          input.receipt_kind,
        );
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

  private async findReceiptByIdempotencyKey(executor: DbExecutor, key: string) {
    return executor
      .selectFrom('supplier_receipts')
      .select([
        'id',
        'supplier_id',
        'receipt_kind',
        'store_name',
        'receipt_number',
        'notes',
        sql<string>`to_char(received_at, 'YYYY-MM-DD')`.as('received_at'),
        'recorded_by_user_id',
      ])
      .where('idempotency_key', '=', key)
      .executeTakeFirst();
  }

  private async returnForRetry(
    executor: DbExecutor,
    existing: {
      id: string;
      supplier_id: string | null;
      receipt_kind: string;
      store_name: string | null;
      receipt_number: string | null;
      notes: string | null;
      received_at: string;
      recorded_by_user_id: string;
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
      existing.receipt_kind === input.receipt_kind &&
      existing.store_name === (input.store_name ?? null) &&
      existing.receipt_number === (input.receipt_number ?? null) &&
      existing.notes === (input.notes ?? null) &&
      existing.received_at === input.received_at &&
      existing.recorded_by_user_id === input.recorded_by_user_id &&
      this.itemFingerprint(existingItems) === this.itemFingerprint(input.items);
    if (!sameRequest)
      throw new ConflictException(
        'Idempotency key was already used for another supplier receipt',
      );

    const detail = await findReceiptDetails(
      executor,
      existing.id,
      input.receipt_kind,
    );
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

  private isUniqueViolation(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === '23505'
    );
  }
}
