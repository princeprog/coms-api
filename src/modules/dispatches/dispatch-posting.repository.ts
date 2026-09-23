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
import type { ScopedActionInput } from './dispatches.types';
import { DispatchesRepository } from './dispatches.repository';
import { isUniqueViolation, negate } from './dispatches.repository.utils';

@Injectable()
export class DispatchPostingRepository {
  constructor(
    @Inject(DATABASE) private readonly db: Kysely<DB>,
    private readonly queries: DispatchesRepository,
  ) {}

  async dispatch(input: ScopedActionInput) {
    try {
      return await this.db.transaction().execute(async (transaction) => {
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

        const items = await this.queries.loadDispatchItems(
          transaction,
          input.id,
        );
        if (!items.length)
          throw new BadRequestException('Dispatch has no items to post');
        const stockItemIds = items.map((item) => item.stock_item_id);
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

        for (const item of items) {
          await transaction
            .insertInto('commissary_inventory')
            .values({
              stock_item_id: item.stock_item_id,
              quantity_on_hand: '0',
            })
            .onConflict((conflict) =>
              conflict.column('stock_item_id').doNothing(),
            )
            .execute();
          const balance = await transaction
            .updateTable('commissary_inventory')
            .set({
              quantity_on_hand: sql`quantity_on_hand - ${item.quantity_dispatched}`,
              updated_at: sql<Date>`now()`,
            })
            .where('stock_item_id', '=', item.stock_item_id)
            .where(
              sql<SqlBool>`quantity_on_hand >= ${item.quantity_dispatched}`,
            )
            .returning('quantity_on_hand')
            .executeTakeFirst();
          if (!balance)
            throw new BadRequestException(
              'Insufficient commissary inventory to dispatch all requested items',
            );

          await transaction
            .insertInto('inventory_movements')
            .values({
              inventory_scope: 'COMMISSARY',
              branch_id: null,
              stock_item_id: item.stock_item_id,
              movement_type: 'DISPATCH',
              quantity_delta: negate(item.quantity_dispatched),
              actor_user_id: input.actor_user_id,
              dispatch_item_id: item.id,
            })
            .execute();
        }

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
}
