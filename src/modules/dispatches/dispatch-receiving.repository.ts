import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { DATABASE } from '../../database/database.module';
import type { DB } from '../../database/db';
import type {
  CloseShortageInput,
  DispatchDbExecutor,
  ReceiveInput,
} from './dispatches.types';
import { DispatchesRepository } from './dispatches.repository';
import {
  isUniqueViolation,
  itemFingerprint,
} from './dispatches.repository.utils';

@Injectable()
export class DispatchReceivingRepository {
  constructor(
    @Inject(DATABASE) private readonly db: Kysely<DB>,
    private readonly queries: DispatchesRepository,
  ) {}

  async receive(input: ReceiveInput) {
    try {
      return await this.db.transaction().execute(async (transaction) => {
        const previous = await this.findReceiptByIdempotencyKey(
          transaction,
          input.idempotency_key,
        );
        if (previous)
          return this.returnForReceiptRetry(transaction, previous, input);
        const previousEvent = await this.queries.findEventByIdempotencyKey(
          transaction,
          input.idempotency_key,
        );
        if (previousEvent)
          return this.queries.returnForActionRetry(
            transaction,
            previousEvent,
            input,
            'RECEIPT_RECORDED',
          );

        const dispatch = await this.queries.findDispatchForUpdate(
          transaction,
          input.id,
          input.branch_ids,
        );
        if (!dispatch) throw new NotFoundException('Dispatch not found');
        const afterLock = await this.findReceiptByIdempotencyKey(
          transaction,
          input.idempotency_key,
        );
        if (afterLock)
          return this.returnForReceiptRetry(transaction, afterLock, input);
        const eventAfterLock = await this.queries.findEventByIdempotencyKey(
          transaction,
          input.idempotency_key,
        );
        if (eventAfterLock)
          return this.queries.returnForActionRetry(
            transaction,
            eventAfterLock,
            input,
            'RECEIPT_RECORDED',
          );
        if (dispatch.status === 'DRAFT')
          throw new ConflictException(
            'Dispatch must be posted before receiving',
          );
        if (
          dispatch.status === 'RECEIVED' ||
          dispatch.status === 'CLOSED_WITH_SHORTAGE'
        )
          throw new ConflictException(
            'Dispatch has no remaining in-transit items',
          );
        await this.queries.requireActiveBranch(transaction, dispatch.branch_id);

        const dispatchItems = await this.queries.loadDispatchItems(
          transaction,
          input.id,
        );
        const dispatchItemsById = new Map(
          dispatchItems.map((item) => [item.id, item]),
        );
        for (const item of input.items) {
          if (!dispatchItemsById.has(item.dispatch_item_id))
            throw new NotFoundException('Dispatch item not found');
          if (!(await this.queries.hasRemainingQuantity(transaction, item)))
            throw new BadRequestException(
              'Received quantity exceeds the remaining in-transit quantity',
            );
        }

        const receipt = await transaction
          .insertInto('dispatch_receipts')
          .values({
            dispatch_id: input.id,
            received_by_user_id: input.actor_user_id,
            idempotency_key: input.idempotency_key,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        for (const item of input.items) {
          const dispatchItem = dispatchItemsById.get(item.dispatch_item_id)!;
          const receiptItem = await transaction
            .insertInto('dispatch_receipt_items')
            .values({
              dispatch_receipt_id: receipt.id,
              dispatch_item_id: dispatchItem.id,
              quantity_received: item.quantity,
            })
            .returning('id')
            .executeTakeFirstOrThrow();

          await transaction
            .insertInto('branch_inventory')
            .values({
              branch_id: dispatch.branch_id,
              stock_item_id: dispatchItem.stock_item_id,
              quantity_on_hand: '0',
            })
            .onConflict((conflict) =>
              conflict.columns(['branch_id', 'stock_item_id']).doNothing(),
            )
            .execute();
          await transaction
            .updateTable('branch_inventory')
            .set({
              quantity_on_hand: sql`quantity_on_hand + ${item.quantity}`,
              updated_at: sql<Date>`now()`,
            })
            .where('branch_id', '=', dispatch.branch_id)
            .where('stock_item_id', '=', dispatchItem.stock_item_id)
            .executeTakeFirstOrThrow();
          await transaction
            .insertInto('inventory_movements')
            .values({
              inventory_scope: 'BRANCH',
              branch_id: dispatch.branch_id,
              stock_item_id: dispatchItem.stock_item_id,
              movement_type: 'TRANSFER_IN',
              quantity_delta: item.quantity,
              actor_user_id: input.actor_user_id,
              dispatch_receipt_item_id: receiptItem.id,
            })
            .execute();
        }
        await transaction
          .insertInto('dispatch_events')
          .values({
            dispatch_id: input.id,
            event_type: 'RECEIPT_RECORDED',
            actor_user_id: input.actor_user_id,
            idempotency_key: input.idempotency_key,
            dispatch_receipt_id: receipt.id,
          })
          .execute();
        await this.queries.refreshStatus(transaction, input.id);

        const details = await this.queries.findDetails(transaction, input.id);
        if (!details) throw new NotFoundException('Dispatch not found');
        return details;
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const existing = await this.findReceiptByIdempotencyKey(
        this.db,
        input.idempotency_key,
      );
      if (existing) return this.returnForReceiptRetry(this.db, existing, input);
      const event = await this.queries.findEventByIdempotencyKey(
        this.db,
        input.idempotency_key,
      );
      if (event)
        return this.queries.returnForActionRetry(
          this.db,
          event,
          input,
          'RECEIPT_RECORDED',
        );
      throw new ConflictException('Idempotency key was already used');
    }
  }

  async closeShortage(input: CloseShortageInput) {
    try {
      return await this.db.transaction().execute(async (transaction) => {
        const previous = await this.findShortageByIdempotencyKey(
          transaction,
          input.idempotency_key,
        );
        if (previous)
          return this.returnForShortageRetry(transaction, previous, input);
        const previousEvent = await this.queries.findEventByIdempotencyKey(
          transaction,
          input.idempotency_key,
        );
        if (previousEvent)
          return this.queries.returnForActionRetry(
            transaction,
            previousEvent,
            input,
            'SHORTAGE_CLOSED',
          );

        const dispatch = await this.queries.findDispatchForUpdate(
          transaction,
          input.id,
          input.branch_ids,
        );
        if (!dispatch) throw new NotFoundException('Dispatch not found');
        const afterLock = await this.findShortageByIdempotencyKey(
          transaction,
          input.idempotency_key,
        );
        if (afterLock)
          return this.returnForShortageRetry(transaction, afterLock, input);
        const eventAfterLock = await this.queries.findEventByIdempotencyKey(
          transaction,
          input.idempotency_key,
        );
        if (eventAfterLock)
          return this.queries.returnForActionRetry(
            transaction,
            eventAfterLock,
            input,
            'SHORTAGE_CLOSED',
          );
        if (dispatch.status === 'DRAFT')
          throw new ConflictException(
            'Dispatch must be posted before closing a shortage',
          );
        if (
          dispatch.status === 'RECEIVED' ||
          dispatch.status === 'CLOSED_WITH_SHORTAGE'
        )
          throw new ConflictException(
            'Dispatch has no remaining in-transit items',
          );

        const dispatchItems = await this.queries.loadDispatchItems(
          transaction,
          input.id,
        );
        const dispatchItemsById = new Map(
          dispatchItems.map((item) => [item.id, item]),
        );
        for (const item of input.items) {
          if (!dispatchItemsById.has(item.dispatch_item_id))
            throw new NotFoundException('Dispatch item not found');
          if (!(await this.queries.hasRemainingQuantity(transaction, item)))
            throw new BadRequestException(
              'Closed shortage quantity exceeds the remaining in-transit quantity',
            );
        }

        const closure = await transaction
          .insertInto('dispatch_shortage_closures')
          .values({
            dispatch_id: input.id,
            closed_by_user_id: input.actor_user_id,
            idempotency_key: input.idempotency_key,
            reason: input.reason,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto('dispatch_shortage_closure_items')
          .values(
            input.items.map((item) => ({
              shortage_closure_id: closure.id,
              dispatch_item_id: item.dispatch_item_id,
              quantity_closed: item.quantity,
            })),
          )
          .execute();
        await transaction
          .insertInto('dispatch_events')
          .values({
            dispatch_id: input.id,
            event_type: 'SHORTAGE_CLOSED',
            actor_user_id: input.actor_user_id,
            idempotency_key: input.idempotency_key,
            shortage_closure_id: closure.id,
          })
          .execute();
        await this.queries.refreshStatus(transaction, input.id);

        const details = await this.queries.findDetails(transaction, input.id);
        if (!details) throw new NotFoundException('Dispatch not found');
        return details;
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const existing = await this.findShortageByIdempotencyKey(
        this.db,
        input.idempotency_key,
      );
      if (existing)
        return this.returnForShortageRetry(this.db, existing, input);
      const event = await this.queries.findEventByIdempotencyKey(
        this.db,
        input.idempotency_key,
      );
      if (event)
        return this.queries.returnForActionRetry(
          this.db,
          event,
          input,
          'SHORTAGE_CLOSED',
        );
      throw new ConflictException('Idempotency key was already used');
    }
  }

  private findReceiptByIdempotencyKey(
    executor: DispatchDbExecutor,
    key: string,
  ) {
    return executor
      .selectFrom('dispatch_receipts')
      .select(['id', 'dispatch_id', 'received_by_user_id'])
      .where('idempotency_key', '=', key)
      .executeTakeFirst();
  }

  private async returnForReceiptRetry(
    executor: DispatchDbExecutor,
    existing: {
      id: string;
      dispatch_id: string;
      received_by_user_id: string;
    },
    input: ReceiveInput,
  ) {
    const storedItems = await executor
      .selectFrom('dispatch_receipt_items')
      .select(['dispatch_item_id', 'quantity_received'])
      .where('dispatch_receipt_id', '=', existing.id)
      .execute();
    const sameItems =
      itemFingerprint(storedItems, 'quantity_received') ===
      itemFingerprint(input.items, 'quantity');
    if (
      existing.dispatch_id !== input.id ||
      existing.received_by_user_id !== input.actor_user_id ||
      !sameItems
    )
      throw new ConflictException(
        'Idempotency key was already used for another dispatch receipt',
      );
    const details = await this.queries.findDetails(executor, input.id);
    if (!details) throw new NotFoundException('Dispatch not found');
    return details;
  }

  private findShortageByIdempotencyKey(
    executor: DispatchDbExecutor,
    key: string,
  ) {
    return executor
      .selectFrom('dispatch_shortage_closures')
      .select(['id', 'dispatch_id', 'closed_by_user_id', 'reason'])
      .where('idempotency_key', '=', key)
      .executeTakeFirst();
  }

  private async returnForShortageRetry(
    executor: DispatchDbExecutor,
    existing: {
      id: string;
      dispatch_id: string;
      closed_by_user_id: string;
      reason: string;
    },
    input: CloseShortageInput,
  ) {
    const storedItems = await executor
      .selectFrom('dispatch_shortage_closure_items')
      .select(['dispatch_item_id', 'quantity_closed'])
      .where('shortage_closure_id', '=', existing.id)
      .execute();
    const sameItems =
      itemFingerprint(storedItems, 'quantity_closed') ===
      itemFingerprint(input.items, 'quantity');
    if (
      existing.dispatch_id !== input.id ||
      existing.closed_by_user_id !== input.actor_user_id ||
      existing.reason !== input.reason ||
      !sameItems
    )
      throw new ConflictException(
        'Idempotency key was already used for another shortage closure',
      );
    const details = await this.queries.findDetails(executor, input.id);
    if (!details) throw new NotFoundException('Dispatch not found');
    return details;
  }
}
