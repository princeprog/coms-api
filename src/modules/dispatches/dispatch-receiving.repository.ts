import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { sql, type Kysely, type SqlBool, type Transaction } from 'kysely';
import { DATABASE } from '../../database/database.module';
import type { DB } from '../../database/db';
import type {
  CloseShortageInput,
  DispatchDbExecutor,
  ReceiveInput,
} from './dispatches.types';
import {
  DispatchesRepository,
  type DispatchOutstandingLine,
} from './dispatches.repository';
import {
  compareDecimal,
  isUniqueViolation,
  itemFingerprint,
  negate,
} from './dispatches.repository.utils';

const DEFAULT_VARIANCE_NOTE =
  'The branch count differs from the dispatched quantities.';

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
            'Dispatch must be sent before it can be counted',
          );
        if (dispatch.counted_at)
          throw new ConflictException('This delivery has already been counted');
        if (
          dispatch.status === 'RECEIVED' ||
          dispatch.status === 'CLOSED_WITH_SHORTAGE'
        )
          throw new ConflictException(
            'Dispatch has no remaining in-transit items',
          );
        if (dispatch.dispatched_by_user_id === input.actor_user_id)
          throw new ForbiddenException(
            'The person who sent this dispatch cannot count it',
          );
        await this.queries.requireActiveBranch(transaction, dispatch.branch_id);

        const lines = await this.queries.loadOutstanding(transaction, input.id);
        const inTransit = new Map(
          lines
            .filter((line) => compareDecimal(line.quantity_outstanding, '0') > 0)
            .map((line) => [line.id, line]),
        );
        if (
          input.items.length !== inTransit.size ||
          input.items.some((item) => !inTransit.has(item.dispatch_item_id))
        )
          throw new BadRequestException(
            'Count every item in this delivery exactly once',
          );

        const receipt = await transaction
          .insertInto('dispatch_receipts')
          .values({
            dispatch_id: input.id,
            received_by_user_id: input.actor_user_id,
            idempotency_key: input.idempotency_key,
            note: input.note,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        for (const item of input.items) {
          const line = inTransit.get(item.dispatch_item_id)!;
          const receiptItem = await transaction
            .insertInto('dispatch_receipt_items')
            .values({
              dispatch_receipt_id: receipt.id,
              dispatch_item_id: line.id,
              quantity_received: item.quantity,
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          if (compareDecimal(item.quantity, '0') === 0) continue;

          await transaction
            .insertInto('branch_inventory')
            .values({
              branch_id: dispatch.branch_id,
              stock_item_id: line.stock_item_id,
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
            .where('stock_item_id', '=', line.stock_item_id)
            .executeTakeFirstOrThrow();
          await transaction
            .insertInto('inventory_movements')
            .values({
              inventory_scope: 'BRANCH',
              branch_id: dispatch.branch_id,
              stock_item_id: line.stock_item_id,
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
        await transaction
          .updateTable('dispatches')
          .set({
            counted_at: sql<Date>`now()`,
            counted_by_user_id: input.actor_user_id,
            updated_at: sql<Date>`now()`,
          })
          .where('id', '=', input.id)
          .executeTakeFirstOrThrow();
        await this.queries.refreshStatus(transaction, input.id);
        if (await this.queries.hasOutstanding(transaction, input.id))
          await this.openVariance(transaction, input);
        else
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
        if (dispatch.status === 'DRAFT' || !dispatch.counted_at)
          throw new ConflictException(
            'The branch must count this delivery before a variance can be resolved',
          );
        if (
          dispatch.status === 'RECEIVED' ||
          dispatch.status === 'CLOSED_WITH_SHORTAGE'
        )
          throw new ConflictException('This dispatch has no unresolved variance');
        if (dispatch.counted_by_user_id === input.actor_user_id)
          throw new ForbiddenException(
            'The person who counted this delivery cannot resolve its variance',
          );

        const lines = new Map(
          (await this.queries.loadOutstanding(transaction, input.id)).map(
            (line) => [line.id, line],
          ),
        );
        for (const item of input.items) {
          const line = lines.get(item.dispatch_item_id);
          if (!line) throw new NotFoundException('Dispatch item not found');
          this.requireResolvableQuantity(line, item.quantity, input.outcome);
        }

        const closure = await transaction
          .insertInto('dispatch_shortage_closures')
          .values({
            dispatch_id: input.id,
            closed_by_user_id: input.actor_user_id,
            idempotency_key: input.idempotency_key,
            outcome: input.outcome,
            reason: input.reason,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        const closureItems = await transaction
          .insertInto('dispatch_shortage_closure_items')
          .values(
            input.items.map((item) => ({
              shortage_closure_id: closure.id,
              dispatch_item_id: item.dispatch_item_id,
              quantity_closed: item.quantity,
            })),
          )
          .returning(['id', 'dispatch_item_id', 'quantity_closed'])
          .execute();
        if (input.outcome !== 'LOST') {
          // Lock commissary rows in stock-item order, matching dispatch sending.
          const ordered = closureItems
            .map((closureItem) => ({
              closureItemId: closureItem.id,
              line: lines.get(closureItem.dispatch_item_id)!,
              quantity: String(closureItem.quantity_closed),
            }))
            .sort((a, b) =>
              a.line.stock_item_id.localeCompare(b.line.stock_item_id),
            );
          for (const entry of ordered)
            await this.correctCommissaryStock(
              transaction,
              entry,
              input.outcome,
              input.actor_user_id,
            );
        }
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

  private requireResolvableQuantity(
    line: DispatchOutstandingLine,
    quantity: string,
    outcome: CloseShortageInput['outcome'],
  ) {
    const outstanding = line.quantity_outstanding;
    if (outcome === 'SURPLUS') {
      const surplus = negate(outstanding);
      if (
        compareDecimal(outstanding, '0') >= 0 ||
        compareDecimal(quantity, surplus) > 0
      )
        throw new BadRequestException(
          `Confirmed surplus for ${line.stock_item_name} cannot exceed the unresolved surplus`,
        );
      return;
    }
    if (
      compareDecimal(outstanding, '0') <= 0 ||
      compareDecimal(quantity, outstanding) > 0
    )
      throw new BadRequestException(
        `Resolved shortage for ${line.stock_item_name} cannot exceed the unresolved shortage`,
      );
  }

  private async correctCommissaryStock(
    transaction: Transaction<DB>,
    entry: {
      closureItemId: string;
      line: DispatchOutstandingLine;
      quantity: string;
    },
    outcome: 'NOT_LOADED' | 'SURPLUS',
    actorUserId: string,
  ) {
    const { line, quantity } = entry;
    if (outcome === 'NOT_LOADED') {
      await transaction
        .insertInto('commissary_inventory')
        .values({ stock_item_id: line.stock_item_id, quantity_on_hand: '0' })
        .onConflict((conflict) => conflict.column('stock_item_id').doNothing())
        .execute();
      await transaction
        .updateTable('commissary_inventory')
        .set({
          quantity_on_hand: sql`quantity_on_hand + ${quantity}`,
          updated_at: sql<Date>`now()`,
        })
        .where('stock_item_id', '=', line.stock_item_id)
        .executeTakeFirstOrThrow();
    } else {
      const balance = await transaction
        .updateTable('commissary_inventory')
        .set({
          quantity_on_hand: sql`quantity_on_hand - ${quantity}`,
          updated_at: sql<Date>`now()`,
        })
        .where('stock_item_id', '=', line.stock_item_id)
        .where(sql<SqlBool>`quantity_on_hand >= ${quantity}`)
        .returning('quantity_on_hand')
        .executeTakeFirst();
      if (!balance)
        throw new ConflictException(
          `Commissary stock for ${line.stock_item_name} is lower than the confirmed surplus. Correct the commissary count first.`,
        );
    }
    await transaction
      .insertInto('inventory_movements')
      .values({
        inventory_scope: 'COMMISSARY',
        branch_id: null,
        stock_item_id: line.stock_item_id,
        movement_type: outcome === 'NOT_LOADED' ? 'DISPATCH_RETURN' : 'DISPATCH',
        quantity_delta: outcome === 'NOT_LOADED' ? quantity : negate(quantity),
        actor_user_id: actorUserId,
        dispatch_shortage_closure_item_id: entry.closureItemId,
      })
      .execute();
  }

  private async openVariance(
    transaction: DispatchDbExecutor,
    input: ReceiveInput,
  ) {
    const active = await sql<{ id: string }>`
      SELECT id FROM dispatch_discrepancies
      WHERE dispatch_id = ${input.id} AND status <> 'RESOLVED'
      FOR UPDATE
    `.execute(transaction);
    if (active.rows[0]) return;
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
        (${discrepancyId}, 'REPORTED', ${input.actor_user_id},
         ${input.note ?? DEFAULT_VARIANCE_NOTE}, ${input.idempotency_key})
    `.execute(transaction);
  }

  private async resolveDiscrepancyIfComplete(
    transaction: DispatchDbExecutor,
    dispatchId: string,
    actorUserId: string,
    idempotencyKey: string,
    eventType: 'RESOLVED_RECEIVED' | 'RESOLVED_SHORTAGE',
    note: string,
  ) {
    if (await this.queries.hasOutstanding(transaction, dispatchId)) return;
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

  private findReceiptByIdempotencyKey(
    executor: DispatchDbExecutor,
    key: string,
  ) {
    return executor
      .selectFrom('dispatch_receipts')
      .select(['id', 'dispatch_id', 'received_by_user_id', 'note'])
      .where('idempotency_key', '=', key)
      .executeTakeFirst();
  }

  private async returnForReceiptRetry(
    executor: DispatchDbExecutor,
    existing: {
      id: string;
      dispatch_id: string;
      received_by_user_id: string;
      note: string | null;
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
      existing.note !== input.note ||
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
      .select(['id', 'dispatch_id', 'closed_by_user_id', 'outcome', 'reason'])
      .where('idempotency_key', '=', key)
      .executeTakeFirst();
  }

  private async returnForShortageRetry(
    executor: DispatchDbExecutor,
    existing: {
      id: string;
      dispatch_id: string;
      closed_by_user_id: string;
      outcome: string;
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
      existing.outcome !== input.outcome ||
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
