import {
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

        const stockRequest = await transaction
          .selectFrom('stock_requests as sr')
          .innerJoin('branches as b', 'b.id', 'sr.branch_id')
          .select([
            'sr.id',
            'sr.branch_id',
            'sr.status',
            'b.status as branch_status',
          ])
          .where('sr.id', '=', input.stock_request_id)
          .forUpdate()
          .executeTakeFirst();
        if (!stockRequest)
          throw new NotFoundException('Stock request not found');
        const dispatchCreatedWhileWaiting =
          await this.findDispatchByIdempotencyKey(
            transaction,
            input.idempotency_key,
          );
        if (dispatchCreatedWhileWaiting)
          return this.returnForCreateRetry(
            transaction,
            dispatchCreatedWhileWaiting,
            input,
          );
        if (
          await this.queries.findEventByIdempotencyKey(
            transaction,
            input.idempotency_key,
          )
        )
          throw new ConflictException('Idempotency key was already used');
        if (stockRequest.status !== 'APPROVED')
          throw new ConflictException(
            'Only approved stock requests can be dispatched',
          );
        if (stockRequest.branch_status !== 'active')
          throw new NotFoundException('Active branch not found');

        const existingDispatch = await transaction
          .selectFrom('dispatches')
          .select('id')
          .where('stock_request_id', '=', input.stock_request_id)
          .executeTakeFirst();
        if (existingDispatch)
          throw new ConflictException(
            'A dispatch already exists for this stock request',
          );

        const items = await transaction
          .selectFrom('stock_request_items as sri')
          .innerJoin('stock_items as si', 'si.id', 'sri.stock_item_id')
          .select(['sri.id', 'sri.stock_item_id', 'sri.quantity_requested'])
          .where('sri.stock_request_id', '=', input.stock_request_id)
          .where('si.is_active', '=', true)
          .orderBy('si.stock_item_name')
          .orderBy('sri.id')
          .forUpdate()
          .execute();
        const allItemCount = await transaction
          .selectFrom('stock_request_items')
          .select((eb) => eb.fn.countAll<number>().as('total'))
          .where('stock_request_id', '=', input.stock_request_id)
          .executeTakeFirstOrThrow();
        if (!items.length || items.length !== Number(allItemCount.total))
          throw new NotFoundException(
            'One or more active stock request items were not found',
          );

        const dispatch = await transaction
          .insertInto('dispatches')
          .values({
            stock_request_id: input.stock_request_id,
            branch_id: stockRequest.branch_id,
            idempotency_key: input.idempotency_key,
            created_by_user_id: input.created_by_user_id,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto('dispatch_items')
          .values(
            items.map((item) => ({
              dispatch_id: dispatch.id,
              stock_request_item_id: item.id,
              quantity_dispatched: String(item.quantity_requested),
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
      const existingRequestDispatch = await this.db
        .selectFrom('dispatches')
        .select('id')
        .where('stock_request_id', '=', input.stock_request_id)
        .executeTakeFirst();
      if (existingRequestDispatch)
        throw new ConflictException(
          'A dispatch already exists for this stock request',
        );
      throw new ConflictException('Idempotency key was already used');
    }
  }

  private async findDispatchByIdempotencyKey(
    executor: DispatchDbExecutor,
    key: string,
  ) {
    return executor
      .selectFrom('dispatches')
      .select(['id', 'stock_request_id', 'created_by_user_id'])
      .where('idempotency_key', '=', key)
      .executeTakeFirst();
  }

  private async returnForCreateRetry(
    executor: DispatchDbExecutor,
    existing: {
      id: string;
      stock_request_id: string;
      created_by_user_id: string;
    },
    input: CreateDraftInput,
  ) {
    if (
      existing.stock_request_id !== input.stock_request_id ||
      existing.created_by_user_id !== input.created_by_user_id
    )
      throw new ConflictException(
        'Idempotency key was already used for another dispatch',
      );
    const details = await this.queries.findDetails(executor, existing.id);
    if (!details) throw new NotFoundException('Dispatch not found');
    return details;
  }
}
