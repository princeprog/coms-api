import {
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
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
import type { SaleQueryDto } from './dto/sale-query.dto';

type DbExecutor = Kysely<DB> | Transaction<DB>;
type Sale = Selectable<DB['sales']>;
type CreateSaleInput = {
  branchId: string;
  actorUserId: string;
  tenderMethod: string;
  idempotencyKey: string;
  items: { productId: string; quantity: string }[];
};
type VoidSaleInput = {
  branchId: string;
  saleId: string;
  actorUserId: string;
  idempotencyKey: string;
  reason: string;
};
type QuantityByStockItem = { stock_item_id: string; quantity: string };

@Injectable()
export class SalesRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DB>) {}

  async list(branchId: string, query: SaleQueryDto) {
    await this.requireBranch(this.db, branchId);
    const records = this.db
      .selectFrom('sales as s')
      .innerJoin('auth.users as u', 'u.id', 's.cashier_user_id')
      .selectAll('s')
      .select('u.full_name as cashier_name')
      .where('s.branch_id', '=', branchId)
      .orderBy('s.created_at', 'desc')
      .orderBy('s.id', 'desc')
      .limit(query.page_size)
      .offset((query.page - 1) * query.page_size);
    const count = this.db
      .selectFrom('sales')
      .select((eb) => eb.fn.countAll<number>().as('total'))
      .where('branch_id', '=', branchId);
    const [items, total] = await Promise.all([
      records.execute(),
      count.executeTakeFirstOrThrow(),
    ]);
    return {
      items,
      total: Number(total.total),
      page: query.page,
      page_size: query.page_size,
    };
  }

  findById(branchId: string, saleId: string) {
    return this.findDetails(this.db, branchId, saleId);
  }

  async create(input: CreateSaleInput) {
    try {
      return await this.db.transaction().execute(async (transaction) => {
        const existing = await transaction
          .selectFrom('sales')
          .selectAll()
          .where('idempotency_key', '=', input.idempotencyKey)
          .forUpdate()
          .executeTakeFirst();
        if (existing)
          return this.returnCreateRetry(transaction, existing, input);

        return this.postSale(transaction, input);
      });
    } catch (error) {
      if (!this.isIdempotencyConflict(error)) throw error;
      const existing = await this.db
        .selectFrom('sales')
        .selectAll()
        .where('idempotency_key', '=', input.idempotencyKey)
        .executeTakeFirst();
      if (!existing) throw error;
      return this.returnCreateRetry(this.db, existing, input);
    }
  }

  async void(input: VoidSaleInput) {
    try {
      return await this.db.transaction().execute(async (transaction) => {
        const eventForKey = await transaction
          .selectFrom('sale_events')
          .selectAll()
          .where('idempotency_key', '=', input.idempotencyKey)
          .executeTakeFirst();
        if (eventForKey) {
          if (
            eventForKey.event_type !== 'VOIDED' ||
            eventForKey.sale_id !== input.saleId ||
            eventForKey.actor_user_id !== input.actorUserId ||
            eventForKey.reason !== input.reason
          )
            throw new ConflictException(
              'Idempotency key has already been used for another void request',
            );
          return this.findDetails(transaction, input.branchId, input.saleId);
        }

        const branch = await transaction
          .selectFrom('branches')
          .select(['id', 'status'])
          .where('id', '=', input.branchId)
          .forShare()
          .executeTakeFirst();
        if (!branch || branch.status !== 'active')
          throw new NotFoundException('Active branch not found');

        const sale = await transaction
          .selectFrom('sales')
          .selectAll()
          .where('id', '=', input.saleId)
          .where('branch_id', '=', input.branchId)
          .forUpdate()
          .executeTakeFirst();
        if (!sale) throw new NotFoundException('Sale not found');

        if (sale.status !== 'COMPLETED') {
          const previousVoid = await transaction
            .selectFrom('sale_events')
            .selectAll()
            .where('sale_id', '=', sale.id)
            .where('event_type', '=', 'VOIDED')
            .executeTakeFirst();
          if (
            previousVoid?.idempotency_key === input.idempotencyKey &&
            previousVoid.actor_user_id === input.actorUserId &&
            previousVoid.reason === input.reason
          )
            return this.findDetails(transaction, input.branchId, sale.id);
          throw new ConflictException('Only a completed sale can be voided');
        }

        const originalMovements = await transaction
          .selectFrom('inventory_movements as im')
          .innerJoin(
            'sale_item_consumptions as sic',
            'sic.id',
            'im.sale_item_consumption_id',
          )
          .innerJoin('sale_items as si', 'si.id', 'sic.sale_item_id')
          .select([
            'im.id',
            'im.inventory_scope',
            'im.branch_id',
            'im.stock_item_id',
            'im.movement_type',
            'im.quantity_delta',
            'im.reversal_of_movement_id',
          ])
          .where('si.sale_id', '=', sale.id)
          .where('im.movement_type', '=', 'SALE')
          .where('im.reversal_of_movement_id', 'is', null)
          .orderBy('im.stock_item_id')
          .orderBy('im.id')
          .execute();
        if (!originalMovements.length)
          throw new InternalServerErrorException(
            'Sale inventory consumption is missing',
          );
        const consumptionCount = await transaction
          .selectFrom('sale_item_consumptions as sic')
          .innerJoin('sale_items as si', 'si.id', 'sic.sale_item_id')
          .select((expression) => expression.fn.countAll().as('count'))
          .where('si.sale_id', '=', sale.id)
          .executeTakeFirstOrThrow();
        if (String(consumptionCount.count) !== String(originalMovements.length))
          throw new InternalServerErrorException(
            'Sale inventory consumption is incomplete',
          );
        if (
          originalMovements.some(
            (movement) =>
              movement.inventory_scope !== 'BRANCH' ||
              movement.branch_id !== input.branchId ||
              !movement.quantity_delta.startsWith('-'),
          )
        )
          throw new InternalServerErrorException(
            'Sale inventory consumption is inconsistent',
          );

        const stockItemIds = [
          ...new Set(
            originalMovements.map(({ stock_item_id }) => stock_item_id),
          ),
        ].sort();
        const stockItems = await transaction
          .selectFrom('stock_items')
          .select('id')
          .where('id', 'in', stockItemIds)
          .orderBy('id')
          .forShare()
          .execute();
        if (stockItems.length !== stockItemIds.length)
          throw new InternalServerErrorException(
            'Sale stock item history is missing',
          );

        const balances = await transaction
          .selectFrom('branch_inventory')
          .select(['stock_item_id', 'quantity_on_hand'])
          .where('branch_id', '=', input.branchId)
          .where('stock_item_id', 'in', stockItemIds)
          .orderBy('stock_item_id')
          .forUpdate()
          .execute();
        if (balances.length !== stockItemIds.length)
          throw new InternalServerErrorException(
            'Sale inventory balance is missing',
          );

        const restoredByStockItem = await this.sumQuantities(
          transaction,
          originalMovements.map((movement) => ({
            stock_item_id: movement.stock_item_id,
            quantity: movement.quantity_delta.slice(1),
          })),
        );
        for (const restored of restoredByStockItem) {
          await transaction
            .updateTable('branch_inventory')
            .set({
              quantity_on_hand: sql`quantity_on_hand + ${restored.quantity}::numeric`,
              updated_at: sql<Date>`now()`,
            })
            .where('branch_id', '=', input.branchId)
            .where('stock_item_id', '=', restored.stock_item_id)
            .executeTakeFirstOrThrow();
        }

        await transaction
          .insertInto('inventory_movements')
          .values(
            originalMovements.map((movement) => ({
              inventory_scope: 'BRANCH',
              branch_id: input.branchId,
              stock_item_id: movement.stock_item_id,
              movement_type: 'SALE_VOID',
              quantity_delta: movement.quantity_delta.slice(1),
              reason: input.reason,
              actor_user_id: input.actorUserId,
              reversal_of_movement_id: movement.id,
            })),
          )
          .execute();

        await transaction
          .updateTable('sales')
          .set({ status: 'VOIDED' })
          .where('id', '=', sale.id)
          .where('status', '=', 'COMPLETED')
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto('sale_events')
          .values({
            sale_id: sale.id,
            event_type: 'VOIDED',
            actor_user_id: input.actorUserId,
            reason: input.reason,
            idempotency_key: input.idempotencyKey,
          })
          .execute();

        return this.findDetails(transaction, input.branchId, sale.id);
      });
    } catch (error) {
      if (!this.isVoidIdempotencyConflict(error)) throw error;
      const existing = await this.db
        .selectFrom('sale_events')
        .selectAll()
        .where('idempotency_key', '=', input.idempotencyKey)
        .executeTakeFirst();
      if (
        !existing ||
        existing.event_type !== 'VOIDED' ||
        existing.sale_id !== input.saleId ||
        existing.actor_user_id !== input.actorUserId ||
        existing.reason !== input.reason
      )
        throw new ConflictException(
          'Idempotency key has already been used for another void request',
        );
      return this.findDetails(this.db, input.branchId, input.saleId);
    }
  }

  private async postSale(transaction: Transaction<DB>, input: CreateSaleInput) {
    const branch = await transaction
      .selectFrom('branches')
      .select(['id', 'status'])
      .where('id', '=', input.branchId)
      .forShare()
      .executeTakeFirst();
    if (!branch || branch.status !== 'active')
      throw new NotFoundException('Active branch not found');

    const productIds = input.items.map(({ productId }) => productId).sort();
    const products = await transaction
      .selectFrom('products')
      .select(['id', 'product_name', 'is_active'])
      .where('id', 'in', productIds)
      .orderBy('id')
      .forShare()
      .execute();
    if (products.length !== productIds.length)
      throw new NotFoundException('One or more products were not found');
    if (products.some(({ is_active }) => !is_active))
      throw new ConflictException('Inactive products cannot be sold');

    const offers = await transaction
      .selectFrom('branch_products')
      .selectAll()
      .where('branch_id', '=', input.branchId)
      .where('product_id', 'in', productIds)
      .orderBy('product_id')
      .forShare()
      .execute();
    if (offers.length !== productIds.length)
      throw new ConflictException(
        'Every sale product must be offered at the branch',
      );
    if (offers.some(({ is_available }) => !is_available))
      throw new ConflictException('Unavailable products cannot be sold');

    const requestValues = sql.join(
      input.items.map(
        ({ productId, quantity }) =>
          sql`(${productId}::uuid, ${quantity}::numeric)`,
      ),
    );
    const recipeItems = await sql<{
      product_id: string;
      stock_item_id: string;
      quantity_consumed: string;
    }>`
      WITH requested(product_id, sale_quantity) AS (VALUES ${requestValues})
      SELECT
        requested.product_id::text AS product_id,
        ingredients.stock_item_id::text AS stock_item_id,
        trim_scale(ingredients.quantity_required * requested.sale_quantity)::text AS quantity_consumed
      FROM requested
      INNER JOIN product_ingredients AS ingredients
        ON ingredients.product_id = requested.product_id
      ORDER BY ingredients.stock_item_id, requested.product_id
    `.execute(transaction);
    const productsWithRecipes = new Set(
      recipeItems.rows.map(({ product_id }) => product_id),
    );
    if (
      input.items.some(({ productId }) => !productsWithRecipes.has(productId))
    )
      throw new ConflictException('Every sold product must have a recipe');

    const stockItemIds = [
      ...new Set(recipeItems.rows.map(({ stock_item_id }) => stock_item_id)),
    ].sort();
    const activeStockItems = await transaction
      .selectFrom('stock_items')
      .select('id')
      .where('id', 'in', stockItemIds)
      .where('is_active', '=', true)
      .orderBy('id')
      .forShare()
      .execute();
    if (activeStockItems.length !== stockItemIds.length)
      throw new ConflictException(
        'Every sale recipe ingredient must be active',
      );

    const productById = new Map(
      products.map((product) => [product.id, product]),
    );
    const offerByProductId = new Map(
      offers.map((offer) => [offer.product_id, offer]),
    );
    const pricingValues = sql.join(
      input.items.map((item) => {
        const offer = offerByProductId.get(item.productId);
        if (!offer)
          throw new ConflictException(
            'Every sale product must be offered at the branch',
          );
        return sql`(${item.productId}::uuid, ${item.quantity}::numeric, ${offer.price}::numeric)`;
      }),
    );
    const pricedItems = await sql<{
      product_id: string;
      line_total: string;
    }>`
      SELECT
        product_id::text AS product_id,
        trim_scale(quantity * unit_price)::text AS line_total
      FROM (VALUES ${pricingValues}) AS sale_lines(product_id, quantity, unit_price)
    `.execute(transaction);
    const lineTotalByProduct = new Map(
      pricedItems.rows.map(({ product_id, line_total }) => [
        product_id,
        line_total,
      ]),
    );
    const totalValues = sql.join(
      pricedItems.rows.map(({ line_total }) => sql`(${line_total}::numeric)`),
    );
    const totalResult = await sql<{ total_amount: string }>`
      SELECT trim_scale(sum(line_total))::text AS total_amount
      FROM (VALUES ${totalValues}) AS sale_totals(line_total)
    `.execute(transaction);
    const totalAmount = totalResult.rows[0]?.total_amount;
    if (totalAmount === undefined)
      throw new InternalServerErrorException(
        'Sale total could not be calculated',
      );

    const sale = await transaction
      .insertInto('sales')
      .values({
        branch_id: input.branchId,
        cashier_user_id: input.actorUserId,
        status: 'COMPLETED',
        tender_method: input.tenderMethod,
        total_amount: totalAmount,
        idempotency_key: input.idempotencyKey,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const saleItems = await transaction
      .insertInto('sale_items')
      .values(
        input.items.map((item) => {
          const product = productById.get(item.productId);
          const offer = offerByProductId.get(item.productId);
          const lineTotal = lineTotalByProduct.get(item.productId);
          if (!product || !offer || lineTotal === undefined)
            throw new InternalServerErrorException(
              'Sale product snapshot could not be created',
            );
          return {
            sale_id: sale.id,
            product_id: product.id,
            product_name_snapshot: product.product_name,
            quantity: item.quantity,
            unit_price: offer.price,
            line_total: lineTotal,
          };
        }),
      )
      .returningAll()
      .execute();
    const saleItemByProductId = new Map(
      saleItems.map((saleItem) => [saleItem.product_id, saleItem]),
    );
    const consumptionRows = recipeItems.rows.map((item) => {
      const saleItem = saleItemByProductId.get(item.product_id);
      if (!saleItem)
        throw new InternalServerErrorException(
          'Sale recipe snapshot could not be created',
        );
      return {
        sale_item_id: saleItem.id,
        stock_item_id: item.stock_item_id,
        quantity_consumed: item.quantity_consumed,
      };
    });
    const consumptions = await transaction
      .insertInto('sale_item_consumptions')
      .values(consumptionRows)
      .returningAll()
      .execute();
    const requiredByStockItem = await this.sumQuantities(
      transaction,
      consumptions.map(({ stock_item_id, quantity_consumed }) => ({
        stock_item_id,
        quantity: quantity_consumed,
      })),
    );

    await transaction
      .insertInto('branch_inventory')
      .values(
        requiredByStockItem.map(({ stock_item_id }) => ({
          branch_id: input.branchId,
          stock_item_id,
          quantity_on_hand: '0',
        })),
      )
      .onConflict((conflict) =>
        conflict.columns(['branch_id', 'stock_item_id']).doNothing(),
      )
      .execute();
    const balances = await transaction
      .selectFrom('branch_inventory')
      .select('stock_item_id')
      .where('branch_id', '=', input.branchId)
      .where(
        'stock_item_id',
        'in',
        requiredByStockItem.map(({ stock_item_id }) => stock_item_id),
      )
      .orderBy('stock_item_id')
      .forUpdate()
      .execute();
    if (balances.length !== requiredByStockItem.length)
      throw new InternalServerErrorException(
        'Sale inventory balances could not be locked',
      );

    for (const required of requiredByStockItem) {
      const updated = await transaction
        .updateTable('branch_inventory')
        .set({
          quantity_on_hand: sql`quantity_on_hand - ${required.quantity}::numeric`,
          updated_at: sql<Date>`now()`,
        })
        .where('branch_id', '=', input.branchId)
        .where('stock_item_id', '=', required.stock_item_id)
        .where(sql<SqlBool>`quantity_on_hand >= ${required.quantity}::numeric`)
        .returning('stock_item_id')
        .executeTakeFirst();
      if (!updated)
        throw new ConflictException('Insufficient branch inventory');
    }

    await transaction
      .insertInto('inventory_movements')
      .values(
        consumptions.map((consumption) => ({
          inventory_scope: 'BRANCH',
          branch_id: input.branchId,
          stock_item_id: consumption.stock_item_id,
          movement_type: 'SALE',
          quantity_delta: `-${consumption.quantity_consumed}`,
          actor_user_id: input.actorUserId,
          sale_item_consumption_id: consumption.id,
        })),
      )
      .execute();
    await transaction
      .insertInto('sale_events')
      .values({
        sale_id: sale.id,
        event_type: 'COMPLETED',
        actor_user_id: input.actorUserId,
      })
      .execute();

    return this.findDetails(transaction, input.branchId, sale.id);
  }

  private async sumQuantities(
    executor: DbExecutor,
    values: QuantityByStockItem[],
  ): Promise<QuantityByStockItem[]> {
    const groupedValues = sql.join(
      values.map(
        ({ stock_item_id, quantity }) =>
          sql`(${stock_item_id}::uuid, ${quantity}::numeric)`,
      ),
    );
    const grouped = await sql<QuantityByStockItem>`
      SELECT
        stock_item_id::text AS stock_item_id,
        trim_scale(sum(quantity))::text AS quantity
      FROM (VALUES ${groupedValues}) AS quantities(stock_item_id, quantity)
      GROUP BY stock_item_id
      ORDER BY stock_item_id
    `.execute(executor);
    return grouped.rows;
  }

  private async returnCreateRetry(
    executor: DbExecutor,
    sale: Sale,
    input: CreateSaleInput,
  ) {
    if (
      sale.branch_id !== input.branchId ||
      sale.cashier_user_id !== input.actorUserId ||
      sale.tender_method !== input.tenderMethod
    )
      throw new ConflictException(
        'Idempotency key has already been used for a different sale',
      );

    const savedItems = await executor
      .selectFrom('sale_items')
      .select(['product_id', 'quantity'])
      .where('sale_id', '=', sale.id)
      .orderBy('product_id')
      .execute();
    const requestedItems = [...input.items].sort((a, b) =>
      a.productId.localeCompare(b.productId),
    );
    const matches =
      savedItems.length === requestedItems.length &&
      savedItems.every(
        (saved, index) =>
          saved.product_id === requestedItems[index]?.productId &&
          this.normalizeDecimal(saved.quantity) ===
            requestedItems[index]?.quantity,
      );
    if (!matches)
      throw new ConflictException(
        'Idempotency key has already been used for a different sale',
      );

    return this.findDetails(executor, input.branchId, sale.id);
  }

  private async findDetails(
    executor: DbExecutor,
    branchId: string,
    saleId: string,
  ) {
    const sale = await executor
      .selectFrom('sales')
      .selectAll()
      .where('branch_id', '=', branchId)
      .where('id', '=', saleId)
      .executeTakeFirst();
    if (!sale) throw new NotFoundException('Sale not found');
    const [items, events] = await Promise.all([
      executor
        .selectFrom('sale_items')
        .select([
          'id',
          'product_id',
          'product_name_snapshot',
          'quantity',
          'unit_price',
          'line_total',
          'created_at',
        ])
        .where('sale_id', '=', saleId)
        .orderBy('product_id')
        .execute(),
      executor
        .selectFrom('sale_events')
        .select(['id', 'event_type', 'actor_user_id', 'reason', 'created_at'])
        .where('sale_id', '=', saleId)
        .orderBy('created_at')
        .orderBy('id')
        .execute(),
    ]);
    return { ...sale, items, events };
  }

  private async requireBranch(executor: DbExecutor, branchId: string) {
    const branch = await executor
      .selectFrom('branches')
      .select('id')
      .where('id', '=', branchId)
      .executeTakeFirst();
    if (!branch) throw new NotFoundException('Branch not found');
  }

  private normalizeDecimal(value: string): string {
    const [wholePart, fractionPart = ''] = value.split('.');
    const whole = wholePart.replace(/^0+(?=\d)/, '');
    const fraction = fractionPart.replace(/0+$/, '');
    return `${whole}${fraction ? `.${fraction}` : ''}`;
  }

  private isIdempotencyConflict(
    error: unknown,
  ): error is { code: string; constraint: string } {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === '23505' &&
      'constraint' in error &&
      error.constraint === 'sales_idempotency_key_unique'
    );
  }

  private isVoidIdempotencyConflict(
    error: unknown,
  ): error is { code: string; constraint: string } {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === '23505' &&
      'constraint' in error &&
      error.constraint === 'sale_events_idempotency_key_unique'
    );
  }
}
