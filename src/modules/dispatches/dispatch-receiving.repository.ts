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
  ReportDiscrepancyInput,
  ReceiveInput,
  RequestRecountInput,
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
        await this.resolveDiscrepancyIfComplete(
          transaction,
          input.id,
          input.actor_user_id,
          input.idempotency_key,
          'RESOLVED_RECEIVED',
          'All dispatched quantities were received.',
        );

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

  async reportDiscrepancy(input: ReportDiscrepancyInput) {
    try {
      return await this.db.transaction().execute(async (transaction) => {
        const dispatch = await this.queries.findDispatchForUpdate(
          transaction,
          input.id,
          input.branch_ids,
        );
        if (!dispatch) throw new NotFoundException('Dispatch not found');
        const previousEvent = await this.findDiscrepancyEventByIdempotencyKey(
          transaction,
          input.idempotency_key,
        );
        if (previousEvent)
          return this.returnForDiscrepancyRetry(
            transaction,
            previousEvent,
            input,
            'REPORTED',
            input.note,
          );
        if (input.branch_ids !== null)
          await this.queries.requireActiveBranch(
            transaction,
            dispatch.branch_id,
          );
        if (
          dispatch.status === 'DRAFT' ||
          dispatch.status === 'RECEIVED' ||
          dispatch.status === 'CLOSED_WITH_SHORTAGE'
        )
          throw new ConflictException(
            'A discrepancy can only be reported while quantities remain in transit',
          );

        const remaining = await this.hasRemainingTransit(transaction, input.id);
        if (!remaining)
          throw new ConflictException(
            'Dispatch has no remaining in-transit quantities',
          );
        if (!(await this.hasReceivedQuantity(transaction, input.id)))
          throw new ConflictException(
            'Record a partial receipt before reporting a discrepancy',
          );
        const active = await sql<{ id: string }>`
          SELECT id FROM dispatch_discrepancies
          WHERE dispatch_id = ${input.id} AND status <> 'RESOLVED'
          FOR UPDATE
        `.execute(transaction);
        if (active.rows[0])
          throw new ConflictException(
            'A discrepancy is already open for this dispatch',
          );

        const discrepancy = await sql<{ id: string }>`
          INSERT INTO dispatch_discrepancies
            (dispatch_id, status, reported_by_user_id, idempotency_key)
          VALUES
            (${input.id}, 'OPEN', ${input.actor_user_id}, ${input.idempotency_key})
          RETURNING id
        `.execute(transaction);
        const discrepancyId = discrepancy.rows[0]?.id;
        if (!discrepancyId)
          throw new ConflictException('Could not create discrepancy record');
        await sql`
          INSERT INTO dispatch_discrepancy_events
            (discrepancy_id, event_type, actor_user_id, note, idempotency_key)
          VALUES
            (${discrepancyId}, 'REPORTED', ${input.actor_user_id}, ${input.note}, ${input.idempotency_key})
        `.execute(transaction);
        const details = await this.queries.findDetails(transaction, input.id);
        if (!details) throw new NotFoundException('Dispatch not found');
        return details;
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const previousEvent = await this.findDiscrepancyEventByIdempotencyKey(
        this.db,
        input.idempotency_key,
      );
      if (previousEvent)
        return this.returnForDiscrepancyRetry(
          this.db,
          previousEvent,
          input,
          'REPORTED',
          input.note,
        );
      throw new ConflictException('A discrepancy is already open for dispatch');
    }
  }

  async requestRecount(input: RequestRecountInput) {
    try {
      return await this.db.transaction().execute(async (transaction) => {
        const dispatch = await this.queries.findDispatchForUpdate(
          transaction,
          input.id,
          input.branch_ids,
        );
        if (!dispatch) throw new NotFoundException('Dispatch not found');
        const previousEvent = await this.findDiscrepancyEventByIdempotencyKey(
          transaction,
          input.idempotency_key,
        );
        if (previousEvent)
          return this.returnForDiscrepancyRetry(
            transaction,
            previousEvent,
            input,
            'RECOUNT_REQUESTED',
            input.reason,
          );
        if (input.branch_ids !== null)
          await this.queries.requireActiveBranch(
            transaction,
            dispatch.branch_id,
          );
        const active = await sql<{ id: string; status: string }>`
          SELECT id, status FROM dispatch_discrepancies
          WHERE dispatch_id = ${input.id} AND status <> 'RESOLVED'
          FOR UPDATE
        `.execute(transaction);
        const discrepancy = active.rows[0];
        if (!discrepancy)
          throw new ConflictException(
            'No open discrepancy exists for dispatch',
          );
        if (discrepancy.status !== 'OPEN')
          throw new ConflictException('A recount has already been requested');

        await sql`
          UPDATE dispatch_discrepancies
          SET status = 'RECOUNT_REQUESTED',
              recount_requested_by_user_id = ${input.actor_user_id},
              recount_requested_at = now(), updated_at = now()
          WHERE id = ${discrepancy.id}
        `.execute(transaction);
        await sql`
          INSERT INTO dispatch_discrepancy_events
            (discrepancy_id, event_type, actor_user_id, note, idempotency_key)
          VALUES
            (${discrepancy.id}, 'RECOUNT_REQUESTED', ${input.actor_user_id}, ${input.reason}, ${input.idempotency_key})
        `.execute(transaction);
        const details = await this.queries.findDetails(transaction, input.id);
        if (!details) throw new NotFoundException('Dispatch not found');
        return details;
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const previousEvent = await this.findDiscrepancyEventByIdempotencyKey(
        this.db,
        input.idempotency_key,
      );
      if (previousEvent)
        return this.returnForDiscrepancyRetry(
          this.db,
          previousEvent,
          input,
          'RECOUNT_REQUESTED',
          input.reason,
        );
      throw new ConflictException('A recount is already requested');
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
        await this.resolveDiscrepancyIfComplete(
          transaction,
          input.id,
          input.actor_user_id,
          input.idempotency_key,
          'RESOLVED_SHORTAGE',
          input.reason,
        );

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

  private async hasRemainingTransit(
    executor: DispatchDbExecutor,
    dispatchId: string,
  ) {
    const result = await sql<{ has_remaining: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM dispatch_items AS di
        WHERE di.dispatch_id = ${dispatchId}
          AND di.quantity_dispatched >
            coalesce((SELECT sum(dri.quantity_received)
              FROM dispatch_receipt_items AS dri
              WHERE dri.dispatch_item_id = di.id), 0)
            + coalesce((SELECT sum(dsci.quantity_closed)
              FROM dispatch_shortage_closure_items AS dsci
              WHERE dsci.dispatch_item_id = di.id), 0)
      ) AS has_remaining
    `.execute(executor);
    return result.rows[0]?.has_remaining === true;
  }

  private async hasReceivedQuantity(
    executor: DispatchDbExecutor,
    dispatchId: string,
  ) {
    const result = await sql<{ has_received: boolean }>`
      SELECT EXISTS (
        SELECT 1
        FROM dispatch_receipt_items AS dri
        JOIN dispatch_items AS di ON di.id = dri.dispatch_item_id
        WHERE di.dispatch_id = ${dispatchId}
      ) AS has_received
    `.execute(executor);
    return result.rows[0]?.has_received === true;
  }

  private async resolveDiscrepancyIfComplete(
    transaction: DispatchDbExecutor,
    dispatchId: string,
    actorUserId: string,
    idempotencyKey: string,
    eventType: 'RESOLVED_RECEIVED' | 'RESOLVED_SHORTAGE',
    note: string,
  ) {
    if (await this.hasRemainingTransit(transaction, dispatchId)) return;
    const active = await sql<{ id: string }>`
      SELECT id FROM dispatch_discrepancies
      WHERE dispatch_id = ${dispatchId} AND status <> 'RESOLVED'
      FOR UPDATE
    `.execute(transaction);
    const discrepancyId = active.rows[0]?.id;
    if (!discrepancyId) return;
    await sql`
      UPDATE dispatch_discrepancies
      SET status = 'RESOLVED', resolved_at = now(), updated_at = now()
      WHERE id = ${discrepancyId}
    `.execute(transaction);
    await sql`
      INSERT INTO dispatch_discrepancy_events
        (discrepancy_id, event_type, actor_user_id, note, idempotency_key)
      VALUES
        (${discrepancyId}, ${eventType}, ${actorUserId}, ${note}, ${idempotencyKey})
    `.execute(transaction);
  }

  private findDiscrepancyEventByIdempotencyKey(
    executor: DispatchDbExecutor,
    key: string,
  ) {
    return sql<{
      discrepancy_id: string;
      dispatch_id: string;
      event_type: string;
      actor_user_id: string;
      note: string;
    }>`
      SELECT e.discrepancy_id, d.dispatch_id, e.event_type, e.actor_user_id, e.note
      FROM dispatch_discrepancy_events AS e
      JOIN dispatch_discrepancies AS d ON d.id = e.discrepancy_id
      WHERE e.idempotency_key = ${key}
    `
      .execute(executor)
      .then((result) => result.rows[0]);
  }

  private async returnForDiscrepancyRetry(
    executor: DispatchDbExecutor,
    existing: {
      discrepancy_id: string;
      dispatch_id: string;
      event_type: string;
      actor_user_id: string;
      note: string;
    },
    input: ReportDiscrepancyInput | RequestRecountInput,
    expectedType: string,
    expectedNote: string,
  ) {
    if (
      existing.dispatch_id !== input.id ||
      existing.actor_user_id !== input.actor_user_id ||
      existing.event_type !== expectedType ||
      existing.note !== expectedNote
    )
      throw new ConflictException('Idempotency key was already used');
    const details = await this.queries.findDetails(executor, input.id);
    if (!details) throw new NotFoundException('Dispatch not found');
    return details;
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
