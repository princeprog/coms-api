import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { type Kysely } from 'kysely';
import { DATABASE } from '../../database/database.module';
import type { DB } from '../../database/db';
import type { CreateDraftInput, DispatchDbExecutor } from './dispatches.types';
import { DispatchesRepository } from './dispatches.repository';
import { isUniqueViolation } from './dispatches.repository.utils';

@Injectable()
export class DispatchDraftsRepository {
  constructor(
    @Inject(DATABASE) private readonly db: Kysely<DB>,
    private readonly queries: DispatchesRepository,
  ) {}

  async createDraft(input: CreateDraftInput) {
    const stockItemIds = input.items.map(({ stock_item_id }) => stock_item_id);
    if (
      stockItemIds.length < 1 ||
      stockItemIds.length > 100 ||
      new Set(stockItemIds).size !== stockItemIds.length
    ) {
      throw new BadRequestException(
        'A dispatch must contain between 1 and 100 unique stock items',
      );
    }

    try {
      return await this.db.transaction().execute(async (transaction) => {
        const existing = await this.findDispatchByIdempotencyKey(
          transaction,
          input.idempotency_key,
        );
        if (existing)
          return this.returnForCreateRetry(transaction, existing, input);
        if (
          await this.queries.findEventByIdempotencyKey(
            transaction,
            input.idempotency_key,
          )
        )
          throw new ConflictException('Idempotency key was already used');

        const branch = await transaction
          .selectFrom('branches')
          .select(['id', 'status'])
          .where('id', '=', input.branch_id)
          .forUpdate()
          .executeTakeFirst();
        if (!branch || branch.status !== 'active')
          throw new NotFoundException('Active branch not found');

        const items = await transaction
          .selectFrom('stock_items')
          .select('id')
          .where('id', 'in', [...stockItemIds].sort())
          .where('is_active', '=', true)
          .orderBy('id')
          .forUpdate()
          .execute();
        if (items.length !== stockItemIds.length)
          throw new NotFoundException('One or more active stock items were not found');

        const dispatch = await transaction
          .insertInto('dispatches')
          .values({
            stock_request_id: null,
            branch_id: branch.id,
            idempotency_key: input.idempotency_key,
            created_by_user_id: input.created_by_user_id,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
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
        await transaction
          .insertInto('dispatch_events')
          .values({
            dispatch_id: dispatch.id,
            event_type: 'CREATED',
            actor_user_id: input.created_by_user_id,
            idempotency_key: input.idempotency_key,
          })
          .execute();

        const details = await this.queries.findDetails(
          transaction,
          dispatch.id,
        );
        if (!details) throw new Error('Created dispatch could not be loaded');
        return details;
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const existing = await this.findDispatchByIdempotencyKey(
        this.db,
        input.idempotency_key,
      );
      if (existing) return this.returnForCreateRetry(this.db, existing, input);
      throw new ConflictException('Idempotency key was already used');
    }
  }

  private findDispatchByIdempotencyKey(
    executor: DispatchDbExecutor,
    key: string,
  ) {
    return executor
      .selectFrom('dispatches')
      .select(['id', 'branch_id', 'created_by_user_id'])
      .where('idempotency_key', '=', key)
      .executeTakeFirst();
  }

  private async returnForCreateRetry(
    executor: DispatchDbExecutor,
    existing: { id: string; branch_id: string; created_by_user_id: string },
    input: CreateDraftInput,
  ) {
    if (
      existing.branch_id !== input.branch_id ||
      existing.created_by_user_id !== input.created_by_user_id
    )
      throw new ConflictException(
        'Idempotency key was already used for another dispatch',
      );

    const existingItems = await executor
      .selectFrom('dispatch_items')
      .select(['stock_item_id', 'quantity_dispatched'])
      .where('dispatch_id', '=', existing.id)
      .execute();
    if (this.fingerprint(existingItems) !== this.fingerprint(input.items))
      throw new ConflictException(
        'Idempotency key was already used for another dispatch',
      );

    const details = await this.queries.findDetails(executor, existing.id);
    if (!details) throw new NotFoundException('Dispatch not found');
    return details;
  }

  private fingerprint(
    items: Array<{ stock_item_id: string; quantity_dispatched: string | number }>,
  ) {
    return items
      .map(({ stock_item_id, quantity_dispatched }) =>
        `${stock_item_id}:${String(quantity_dispatched)}`,
      )
      .sort()
      .join('|');
  }
}
