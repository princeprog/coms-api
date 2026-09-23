import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  sql,
  type Kysely,
  type Selectable,
  type SqlBool,
  type Transaction,
} from 'kysely';
import { DATABASE } from '../../database/database.module';
import type { DB } from '../../database/db';
import type { InventoryMovementQueryDto } from './dto/inventory-movement-query.dto';
import type { InventoryQueryDto } from './dto/inventory-query.dto';
import type { InventoryScope } from './inventory.service';

type AdjustmentInput = {
  scope: InventoryScope;
  branchId: string | null;
  stockItemId: string;
  quantityDelta: string;
  reason: string;
  actorUserId: string;
  idempotencyKey: string;
};

@Injectable()
export class InventoryRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DB>) {}

  async branchExists(branchId: string): Promise<boolean> {
    const branch = await this.db
      .selectFrom('branches')
      .select('id')
      .where('id', '=', branchId)
      .executeTakeFirst();
    return Boolean(branch);
  }

  async listCommissary(query: InventoryQueryDto) {
    let records = this.db
      .selectFrom('stock_items as si')
      .leftJoin('commissary_inventory as ci', 'ci.stock_item_id', 'si.id')
      .select([
        'si.id',
        'si.stock_item_name',
        'si.category',
        'si.unit',
        'si.is_active',
        'si.created_at',
        'si.updated_at',
        sql<string>`coalesce(ci.quantity_on_hand, 0)::text`.as(
          'quantity_on_hand',
        ),
      ])
      .orderBy('si.stock_item_name')
      .orderBy('si.id')
      .limit(query.page_size)
      .offset((query.page - 1) * query.page_size);
    let count = this.db
      .selectFrom('stock_items')
      .select((eb) => eb.fn.countAll<number>().as('total'));

    if (query.search) {
      const pattern = this.searchPattern(query.search);
      records = records.where('si.stock_item_name', 'ilike', pattern);
      count = count.where('stock_item_name', 'ilike', pattern);
    }

    const [items, result] = await Promise.all([
      records.execute(),
      count.executeTakeFirstOrThrow(),
    ]);
    return {
      items,
      total: Number(result.total),
      page: query.page,
      page_size: query.page_size,
    };
  }

  async listBranch(branchId: string, query: InventoryQueryDto) {
    let records = this.db
      .selectFrom('stock_items as si')
      .leftJoin('branch_inventory as bi', (join) =>
        join
          .onRef('bi.stock_item_id', '=', 'si.id')
          .on('bi.branch_id', '=', branchId),
      )
      .select([
        'si.id',
        'si.stock_item_name',
        'si.category',
        'si.unit',
        'si.is_active',
        'si.created_at',
        'si.updated_at',
        sql<string>`coalesce(bi.quantity_on_hand, 0)::text`.as(
          'quantity_on_hand',
        ),
      ])
      .orderBy('si.stock_item_name')
      .orderBy('si.id')
      .limit(query.page_size)
      .offset((query.page - 1) * query.page_size);
    let count = this.db
      .selectFrom('stock_items')
      .select((eb) => eb.fn.countAll<number>().as('total'));

    if (query.search) {
      const pattern = this.searchPattern(query.search);
      records = records.where('si.stock_item_name', 'ilike', pattern);
      count = count.where('stock_item_name', 'ilike', pattern);
    }

    const [items, result] = await Promise.all([
      records.execute(),
      count.executeTakeFirstOrThrow(),
    ]);
    return {
      items,
      total: Number(result.total),
      page: query.page,
      page_size: query.page_size,
    };
  }

  async listMovements(
    scope: InventoryScope,
    branchId: string | null,
    query: InventoryMovementQueryDto,
  ) {
    let records = this.db
      .selectFrom('inventory_movements as im')
      .innerJoin('stock_items as si', 'si.id', 'im.stock_item_id')
      .select([
        'im.id',
        'im.inventory_scope',
        'im.branch_id',
        'im.stock_item_id',
        'si.stock_item_name',
        'si.unit',
        'im.movement_type',
        'im.quantity_delta',
        'im.reason',
        'im.actor_user_id',
        'im.idempotency_key',
        'im.created_at',
      ])
      .where('im.inventory_scope', '=', scope)
      .orderBy('im.created_at', 'desc')
      .orderBy('im.id', 'desc')
      .limit(query.page_size)
      .offset((query.page - 1) * query.page_size);
    let count = this.db
      .selectFrom('inventory_movements')
      .select((eb) => eb.fn.countAll<number>().as('total'))
      .where('inventory_scope', '=', scope);

    if (branchId) {
      records = records.where('im.branch_id', '=', branchId);
      count = count.where('branch_id', '=', branchId);
    } else {
      records = records.where('im.branch_id', 'is', null);
      count = count.where('branch_id', 'is', null);
    }
    if (query.stock_item_id) {
      records = records.where('im.stock_item_id', '=', query.stock_item_id);
      count = count.where('stock_item_id', '=', query.stock_item_id);
    }

    const [items, result] = await Promise.all([
      records.execute(),
      count.executeTakeFirstOrThrow(),
    ]);
    return {
      items,
      total: Number(result.total),
      page: query.page,
      page_size: query.page_size,
    };
  }

  async postAdjustment(input: AdjustmentInput) {
    try {
      return await this.db.transaction().execute(async (transaction) => {
        const existing = await transaction
          .selectFrom('inventory_movements')
          .selectAll()
          .where('idempotency_key', '=', input.idempotencyKey)
          .executeTakeFirst();
        if (existing) return this.returnForRetry(existing, input);

        if (input.branchId) {
          const branch = await transaction
            .selectFrom('branches')
            .select('id')
            .where('id', '=', input.branchId)
            .where('status', '=', 'active')
            .forUpdate()
            .executeTakeFirst();
          if (!branch) throw new NotFoundException('Active branch not found');
        }

        const stockItem = await transaction
          .selectFrom('stock_items')
          .select('id')
          .where('id', '=', input.stockItemId)
          .where('is_active', '=', true)
          .forUpdate()
          .executeTakeFirst();
        if (!stockItem)
          throw new NotFoundException('Active stock item not found');

        const balance = await this.updateBalance(transaction, input);
        if (!balance)
          throw new BadRequestException(
            'Insufficient inventory for adjustment',
          );

        return transaction
          .insertInto('inventory_movements')
          .values({
            inventory_scope: input.scope,
            branch_id: input.branchId,
            stock_item_id: input.stockItemId,
            movement_type: 'ADJUSTMENT',
            quantity_delta: input.quantityDelta,
            reason: input.reason,
            actor_user_id: input.actorUserId,
            idempotency_key: input.idempotencyKey,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
      });
    } catch (error) {
      if (!this.isUniqueViolation(error)) throw error;

      const existing = await this.findMovementByIdempotencyKey(
        input.idempotencyKey,
      );
      if (existing) return this.returnForRetry(existing, input);
      throw error;
    }
  }

  private async updateBalance(
    transaction: Transaction<DB>,
    input: AdjustmentInput,
  ) {
    if (input.branchId) {
      await transaction
        .insertInto('branch_inventory')
        .values({
          branch_id: input.branchId,
          stock_item_id: input.stockItemId,
          quantity_on_hand: '0',
        })
        .onConflict((conflict) =>
          conflict.columns(['branch_id', 'stock_item_id']).doNothing(),
        )
        .execute();

      return transaction
        .updateTable('branch_inventory')
        .set({
          quantity_on_hand: sql`quantity_on_hand + ${input.quantityDelta}`,
          updated_at: sql<Date>`now()`,
        })
        .where('branch_id', '=', input.branchId)
        .where('stock_item_id', '=', input.stockItemId)
        .where(sql<SqlBool>`quantity_on_hand + ${input.quantityDelta} >= 0`)
        .returning('quantity_on_hand')
        .executeTakeFirst();
    }

    await transaction
      .insertInto('commissary_inventory')
      .values({ stock_item_id: input.stockItemId, quantity_on_hand: '0' })
      .onConflict((conflict) => conflict.column('stock_item_id').doNothing())
      .execute();

    return transaction
      .updateTable('commissary_inventory')
      .set({
        quantity_on_hand: sql`quantity_on_hand + ${input.quantityDelta}`,
        updated_at: sql<Date>`now()`,
      })
      .where('stock_item_id', '=', input.stockItemId)
      .where(sql<SqlBool>`quantity_on_hand + ${input.quantityDelta} >= 0`)
      .returning('quantity_on_hand')
      .executeTakeFirst();
  }

  private findMovementByIdempotencyKey(idempotencyKey: string) {
    return this.db
      .selectFrom('inventory_movements')
      .selectAll()
      .where('idempotency_key', '=', idempotencyKey)
      .executeTakeFirst();
  }

  private returnForRetry(
    movement: Selectable<DB['inventory_movements']>,
    input: AdjustmentInput,
  ) {
    const sameRequest =
      movement.movement_type === 'ADJUSTMENT' &&
      movement.inventory_scope === input.scope &&
      movement.branch_id === input.branchId &&
      movement.stock_item_id === input.stockItemId &&
      this.normalizeDecimal(movement.quantity_delta) === input.quantityDelta &&
      movement.reason === input.reason &&
      movement.actor_user_id === input.actorUserId;
    if (!sameRequest)
      throw new ConflictException(
        'Idempotency key was already used for another adjustment',
      );
    return movement;
  }

  private normalizeDecimal(value: string): string {
    const negative = value.startsWith('-');
    const unsigned = negative ? value.slice(1) : value;
    const [wholePart, fractionPart = ''] = unsigned.split('.');
    const whole = wholePart.replace(/^0+(?=\d)/, '');
    const fraction = fractionPart.replace(/0+$/, '');
    const isZero = whole === '0' && fraction.length === 0;
    return `${negative && !isZero ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
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
