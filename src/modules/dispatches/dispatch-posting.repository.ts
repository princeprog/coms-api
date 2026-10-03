import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { sql, type Kysely, type SqlBool } from 'kysely';
import { DATABASE } from '../../database/database.module';
import type { DB } from '../../database/db';
import type {
  ScopedActionInput,
  CreateDraftInput,
  DispatchDbExecutor,
} from './dispatches.types';
import { DispatchesRepository } from './dispatches.repository';
import {
  isUniqueViolation,
  negate,
  normalizeDecimal,
} from './dispatches.repository.utils';

@Injectable()
export class DispatchPostingRepository {
  constructor(
    @Inject(DATABASE) private readonly db: Kysely<DB>,
    private readonly queries: DispatchesRepository,
  ) {}

  async createAndSend(input: CreateDraftInput) {
    try {
      return await this.db.transaction().execute(async (transaction) => {
        const retry = await this.findSendRetry(transaction, input);
        if (retry) return retry;
        await this.queries.requireActiveBranch(transaction, input.branch_id);
        const activeStockItems = await this.lockActiveStock(
          transaction,
          input.items.map((item) => item.stock_item_id),
        );
        // Both unique keys are claimed before any stock deduction.
        const dispatch = await transaction
          .insertInto('dispatches')
          .values({
            branch_id: input.branch_id,
            stock_request_id: null,
            idempotency_key: input.idempotency_key,
            created_by_user_id: input.created_by_user_id,
            dispatched_by_user_id: input.created_by_user_id,
            dispatched_at: sql<Date>`now()`,
            status: 'IN_TRANSIT',
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto('dispatch_events')
          .values({
            dispatch_id: dispatch.id,
            event_type: 'DISPATCHED',
            actor_user_id: input.created_by_user_id,
            idempotency_key: input.idempotency_key,
          })
          .execute();
        await transaction
          .insertInto('dispatch_items')
          .values(
            input.items.map((item) => ({
              dispatch_id: dispatch.id,
              stock_item_id: item.stock_item_id,
              stock_request_item_id: null,
              quantity_dispatched: item.quantity_dispatched,
            })),
          )
          .execute();
        await this.deductStock(
          transaction,
          dispatch.id,
          input.created_by_user_id,
          activeStockItems,
        );
        const details = await this.queries.findDetails(
          transaction,
          dispatch.id,
        );
        if (!details) throw new NotFoundException('Dispatch not found');
        return details;
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const retry = await this.findSendRetry(this.db, input);
      if (retry) return retry;
      throw new ConflictException(
        'Idempotency key was already used for another action',
      );
    }
  }

  private async findSendRetry(
    executor: DispatchDbExecutor,
    input: CreateDraftInput,
  ) {
    // Read the header and key claim in one snapshot during concurrent retries.
    const existing = await executor
      .selectFrom('dispatch_events as event')
      .leftJoin(
        'dispatches as dispatch',
        'dispatch.idempotency_key',
        'event.idempotency_key',
      )
      .select([
        'dispatch.id',
        'dispatch.branch_id',
        'dispatch.created_by_user_id',
        'event.event_type',
        'event.dispatch_id',
      ])
      .where('event.idempotency_key', '=', input.idempotency_key)
      .executeTakeFirst();
    if (!existing) return undefined;
    if (
      !existing.id ||
      existing.dispatch_id !== existing.id ||
      existing.event_type !== 'DISPATCHED' ||
      existing.branch_id !== input.branch_id ||
      existing.created_by_user_id !== input.created_by_user_id
    )
      throw new ConflictException(
        'Idempotency key was already used for another dispatch or action',
      );
    const items = await this.queries.loadDispatchItems(executor, existing.id);
    const fingerprint = (
      lines: Array<{
        stock_item_id: string;
        quantity_dispatched: string | number;
      }>,
    ) =>
      lines
        .map(
          (line) =>
            `${line.stock_item_id}:${normalizeDecimal(String(line.quantity_dispatched))}`,
        )
        .sort()
        .join('|');
    if (fingerprint(items) !== fingerprint(input.items))
      throw new ConflictException(
        'Idempotency key was already used with different dispatch quantities',
      );
    return this.queries.findDetails(executor, existing.id);
  }

  private async requirePostingKey(executor: DispatchDbExecutor, key: string) {
    if (
      await executor
        .selectFrom('dispatches')
        .select('id')
        .where('idempotency_key', '=', key)
        .executeTakeFirst()
    )
      throw new ConflictException(
        'Idempotency key was already used for another action',
      );
  }

  async dispatch(input: ScopedActionInput) {
    try {
      return await this.db.transaction().execute(async (transaction) => {
        await this.requirePostingKey(transaction, input.idempotency_key);
        const previous = await this.queries.findEventByIdempotencyKey(
          transaction,
          input.idempotency_key,
        );
        if (previous)
          return this.queries.returnForActionRetry(
            transaction,
            previous,
            input,
            'DISPATCHED',
          );

        const dispatch = await this.queries.findDispatchForUpdate(
          transaction,
          input.id,
          input.branch_ids,
        );
        if (!dispatch) throw new NotFoundException('Dispatch not found');
        const afterLock = await this.queries.findEventByIdempotencyKey(
          transaction,
          input.idempotency_key,
        );
        if (afterLock)
          return this.queries.returnForActionRetry(
            transaction,
            afterLock,
            input,
            'DISPATCHED',
          );
        if (dispatch.status !== 'DRAFT')
          throw new ConflictException('Dispatch is not in draft state');
        await this.queries.requireActiveBranch(transaction, dispatch.branch_id);

        await this.deductStock(transaction, input.id, input.actor_user_id);

        await transaction
          .updateTable('dispatches')
          .set({
            status: 'IN_TRANSIT',
            dispatched_by_user_id: input.actor_user_id,
            dispatched_at: sql<Date>`now()`,
            updated_at: sql<Date>`now()`,
          })
          .where('id', '=', input.id)
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto('dispatch_events')
          .values({
            dispatch_id: input.id,
            event_type: 'DISPATCHED',
            actor_user_id: input.actor_user_id,
            idempotency_key: input.idempotency_key,
          })
          .execute();

        const details = await this.queries.findDetails(transaction, input.id);
        if (!details) throw new NotFoundException('Dispatch not found');
        return details;
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      await this.requirePostingKey(this.db, input.idempotency_key);
      const event = await this.queries.findEventByIdempotencyKey(
        this.db,
        input.idempotency_key,
      );
      if (event)
        return this.queries.returnForActionRetry(
          this.db,
          event,
          input,
          'DISPATCHED',
        );
      throw new ConflictException('Idempotency key was already used');
    }
  }
  private async deductStock(
    transaction: DispatchDbExecutor,
    dispatchId: string,
    actorUserId: string,
    lockedStock?: Array<{ id: string; stock_item_name: string; unit: string }>,
  ) {
    const items = await this.queries.loadDispatchItems(transaction, dispatchId);
    if (!items.length)
      throw new BadRequestException('Dispatch has no items to post');
    const activeStockItems =
      lockedStock ??
      (await this.lockActiveStock(
        transaction,
        items.map((item) => item.stock_item_id),
      ));

    for (const item of items) {
      await transaction
        .insertInto('commissary_inventory')
        .values({
          stock_item_id: item.stock_item_id,
          quantity_on_hand: '0',
        })
        .onConflict((conflict) => conflict.column('stock_item_id').doNothing())
        .execute();
      const balance = await transaction
        .updateTable('commissary_inventory')
        .set({
          quantity_on_hand: sql`quantity_on_hand - ${item.quantity_dispatched}`,
          updated_at: sql<Date>`now()`,
        })
        .where('stock_item_id', '=', item.stock_item_id)
        .where(sql<SqlBool>`quantity_on_hand >= ${item.quantity_dispatched}`)
        .returning('quantity_on_hand')
        .executeTakeFirst();
      if (!balance)
        throw new BadRequestException(
          `Insufficient commissary inventory for ${activeStockItems.find((stock) => stock.id === item.stock_item_id)?.stock_item_name}. Requested ${item.quantity_dispatched} ${activeStockItems.find((stock) => stock.id === item.stock_item_id)?.unit}. Reduce the quantity or replenish stock.`,
        );

      await transaction
        .insertInto('inventory_movements')
        .values({
          inventory_scope: 'COMMISSARY',
          branch_id: null,
          stock_item_id: item.stock_item_id,
          movement_type: 'DISPATCH',
          quantity_delta: negate(item.quantity_dispatched),
          actor_user_id: actorUserId,
          dispatch_item_id: item.id,
        })
        .execute();
    }
  }

  private async lockActiveStock(
    transaction: DispatchDbExecutor,
    stockItemIds: string[],
  ) {
    // Lock before inserting line FKs; their user order can otherwise deadlock
    // with supplier receiving or legacy drafts that lock stock in ID order.
    const activeStockItems = await transaction
      .selectFrom('stock_items')
      .select(['id', 'stock_item_name', 'unit'])
      .where('id', 'in', stockItemIds)
      .where('is_active', '=', true)
      .orderBy('id')
      .forNoKeyUpdate()
      .execute();
    if (activeStockItems.length !== stockItemIds.length)
      throw new NotFoundException(
        'One or more active stock items were not found',
      );
    return activeStockItems;
  }
}
