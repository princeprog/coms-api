import { containsSearchPattern } from '../../common/utils/list-filters';
import {
  paginatedResult,
  paginationOffset,
} from '../../common/utils/pagination';
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
import { needsRestockSql, onTheWaySql, stockStatusSql } from './stock-position';

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

  listCommissary(query: InventoryQueryDto) {
    return this.listBalances(null, query);
  }

  listBranch(branchId: string, query: InventoryQueryDto) {
    return this.listBalances(branchId, query);
  }

  // One query shape for both locations so status, levels and the low-stock
  // filter follow the same rule everywhere.
  private async listBalances(
    branchId: string | null,
    query: InventoryQueryDto,
  ) {
    const onHand = branchId
      ? sql<string>`coalesce((SELECT bi.quantity_on_hand FROM branch_inventory bi
          WHERE bi.branch_id = ${branchId}::uuid AND bi.stock_item_id = si.id), 0)`
      : sql<string>`coalesce((SELECT ci.quantity_on_hand FROM commissary_inventory ci
          WHERE ci.stock_item_id = si.id), 0)`;
    const onTheWay = branchId
      ? onTheWaySql(sql`${branchId}::uuid`, sql.ref('si.id'))
      : sql<string>`0`;
    const reorder = sql.ref('sl.reorder_level');
    // Average over 14 days of what leaves this location in normal work:
    // net sales at a branch, net dispatches at the commissary.
    const usage = branchId
      ? sql`im.inventory_scope = 'BRANCH' AND im.branch_id = ${branchId}::uuid
          AND im.movement_type IN ('SALE', 'SALE_VOID')`
      : sql`im.inventory_scope = 'COMMISSARY'
          AND im.movement_type IN ('DISPATCH', 'DISPATCH_RETURN')`;

    let base = this.db
      .selectFrom('stock_items as si')
      .leftJoin('stock_levels as sl', (join) => {
        const item = join.onRef('sl.stock_item_id', '=', 'si.id');
        return branchId
          ? item
              .on('sl.inventory_scope', '=', 'BRANCH')
              .on('sl.branch_id', '=', branchId)
          : item.on('sl.inventory_scope', '=', 'COMMISSARY');
      });

    if (query.search) {
      const pattern = containsSearchPattern(query.search);
      base = base.where((eb) =>
        eb.or([
          eb('si.stock_item_name', 'ilike', pattern),
          eb('si.category', 'ilike', pattern),
        ]),
      );
    }
    if (query.is_active !== undefined)
      base = base.where('si.is_active', '=', query.is_active);
    if (query.category) base = base.where('si.category', '=', query.category);
    if (query.stock === 'low')
      base = base.where(
        sql<SqlBool>`si.is_active AND ${needsRestockSql(onHand, onTheWay, reorder)}`,
      );

    const records = base
      .select([
        'si.id',
        'si.stock_item_name',
        'si.category',
        'si.unit',
        'si.is_active',
        'si.created_at',
        'si.updated_at',
        sql<string>`${onHand}::text`.as('quantity_on_hand'),
        sql<string>`trim_scale(${onTheWay})::text`.as('on_the_way'),
        sql<string | null>`trim_scale(sl.reorder_level)::text`.as(
          'reorder_level',
        ),
        sql<string | null>`trim_scale(sl.target_level)::text`.as(
          'target_level',
        ),
        sql<string>`(SELECT trim_scale(round(
            greatest(-coalesce(sum(im.quantity_delta), 0), 0) / 14, 2))::text
          FROM inventory_movements im
          WHERE im.stock_item_id = si.id AND ${usage}
            AND im.occurred_at >= now() - interval '14 days')`.as(
          'avg_daily_use',
        ),
        stockStatusSql({
          active: sql.ref('si.is_active'),
          onHand,
          onTheWay,
          reorder,
        }).as('stock_status'),
      ])
      .orderBy('si.stock_item_name')
      .orderBy('si.id')
      .limit(query.page_size)
      .offset(paginationOffset(query));
    const count = base.select((eb) => eb.fn.countAll<number>().as('total'));

    const [items, result, categories] = await Promise.all([
      records.execute(),
      count.executeTakeFirstOrThrow(),
      this.listAvailableCategories(),
    ]);
    return {
      ...paginatedResult(items, Number(result.total), query),
      available_categories: categories,
    };
  }

  private async listAvailableCategories(): Promise<string[]> {
    const categories = await this.db
      .selectFrom('stock_items')
      .select('category')
      .distinct()
      .orderBy('category')
      .execute();
    return categories.map(({ category }) => category);
  }

  async listMovements(
    scope: InventoryScope,
    branchId: string | null,
    query: InventoryMovementQueryDto,
  ) {
    let records = this.db
      .selectFrom('inventory_movements as im')
      .leftJoin(
        'supplier_receipt_items as receipt_line',
        'receipt_line.id',
        'im.supplier_receipt_item_id',
      )
      .leftJoin(
        'supplier_receipts as receipt',
        'receipt.id',
        'receipt_line.supplier_receipt_id',
      )
      .innerJoin('stock_items as si', 'si.id', 'im.stock_item_id')
      .select([
        'im.id',
        'receipt.id as receipt_id',
        'receipt.receipt_kind',
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
        'im.occurred_at',
      ])
      .where('im.inventory_scope', '=', scope)
      .orderBy('im.occurred_at', 'desc')
      .orderBy('im.id', 'desc')
      .limit(query.page_size)
      .offset(paginationOffset(query));
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
    return paginatedResult(items, Number(result.total), query);
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

  private isUniqueViolation(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === '23505'
    );
  }
}
