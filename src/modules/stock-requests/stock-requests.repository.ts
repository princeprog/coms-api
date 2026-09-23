import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { sql, type Kysely, type Transaction } from 'kysely';
import { DATABASE } from '../../database/database.module';
import type { DB } from '../../database/db';
import type { StockRequestQueryDto } from './dto/stock-request-query.dto';

type StockRequestItemInput = {
  stock_item_id: string;
  quantity_requested: string;
};

type CreateStockRequestInput = {
  branch_id: string;
  requested_by_user_id: string;
  idempotency_key: string;
  items: StockRequestItemInput[];
};

type DbExecutor = Kysely<DB> | Transaction<DB>;
type RequestStatus = 'APPROVED' | 'REJECTED' | 'CANCELLED';

@Injectable()
export class StockRequestsRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DB>) {}

  async list(input: StockRequestQueryDto, branchIds: string[] | null) {
    let records = this.db
      .selectFrom('stock_requests as sr')
      .innerJoin('branches as b', 'b.id', 'sr.branch_id')
      .innerJoin('auth.users as u', 'u.id', 'sr.requested_by_user_id')
      .select([
        'sr.id',
        'sr.branch_id',
        'b.branch_name',
        'sr.requested_by_user_id',
        'u.full_name as requester_name',
        'sr.status',
        'sr.created_at',
        'sr.updated_at',
        sql<number>`(select count(*)::int from stock_request_items as sri where sri.stock_request_id = sr.id)`.as(
          'item_count',
        ),
      ])
      .orderBy('sr.created_at', 'desc')
      .orderBy('sr.id', 'desc')
      .limit(input.page_size)
      .offset((input.page - 1) * input.page_size);
    let count = this.db
      .selectFrom('stock_requests as sr')
      .select((eb) => eb.fn.countAll<number>().as('total'));

    if (branchIds !== null) {
      records = records.where('sr.branch_id', 'in', branchIds);
      count = count.where('sr.branch_id', 'in', branchIds);
    }
    if (input.branch_id) {
      records = records.where('sr.branch_id', '=', input.branch_id);
      count = count.where('sr.branch_id', '=', input.branch_id);
    }
    if (input.status) {
      records = records.where('sr.status', '=', input.status);
      count = count.where('sr.status', '=', input.status);
    }

    const [items, result] = await Promise.all([
      records.execute(),
      count.executeTakeFirstOrThrow(),
    ]);
    return {
      items,
      total: Number(result.total),
      page: input.page,
      page_size: input.page_size,
    };
  }

  findById(id: string) {
    return this.findDetails(this.db, id);
  }

  async create(input: CreateStockRequestInput) {
    try {
      return await this.db.transaction().execute(async (transaction) => {
        const existing = await this.findByIdempotencyKey(
          transaction,
          input.idempotency_key,
        );
        if (existing) return this.returnForRetry(transaction, existing, input);

        const branch = await transaction
          .selectFrom('branches')
          .select('id')
          .where('id', '=', input.branch_id)
          .where('status', '=', 'active')
          .forUpdate()
          .executeTakeFirst();
        if (!branch) throw new NotFoundException('Active branch not found');

        const stockItemIds = input.items.map((item) => item.stock_item_id);
        const stockItems = await transaction
          .selectFrom('stock_items')
          .select('id')
          .where('id', 'in', stockItemIds)
          .where('is_active', '=', true)
          .orderBy('id')
          .forUpdate()
          .execute();
        if (stockItems.length !== stockItemIds.length)
          throw new NotFoundException(
            'One or more active stock items were not found',
          );

        const request = await transaction
          .insertInto('stock_requests')
          .values({
            branch_id: input.branch_id,
            requested_by_user_id: input.requested_by_user_id,
            idempotency_key: input.idempotency_key,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto('stock_request_items')
          .values(
            input.items.map((item) => ({
              stock_request_id: request.id,
              stock_item_id: item.stock_item_id,
              quantity_requested: item.quantity_requested,
            })),
          )
          .execute();
        await transaction
          .insertInto('stock_request_events')
          .values({
            stock_request_id: request.id,
            event_type: 'SUBMITTED',
            actor_user_id: input.requested_by_user_id,
          })
          .execute();

        const details = await this.findDetails(transaction, request.id);
        if (!details)
          throw new Error('Created stock request could not be loaded');
        return details;
      });
    } catch (error) {
      if (!this.isUniqueViolation(error)) throw error;
      const existing = await this.findByIdempotencyKey(
        this.db,
        input.idempotency_key,
      );
      if (!existing) throw error;
      return this.returnForRetry(this.db, existing, input);
    }
  }

  async transition(
    id: string,
    status: RequestStatus,
    actorUserId: string,
    branchIds: string[] | null,
    requesterOnly = false,
  ) {
    return this.db.transaction().execute(async (transaction) => {
      let query = transaction
        .selectFrom('stock_requests')
        .select(['id', 'branch_id', 'requested_by_user_id', 'status'])
        .where('id', '=', id);
      if (branchIds !== null) query = query.where('branch_id', 'in', branchIds);
      const stockRequest = await query.forUpdate().executeTakeFirst();
      if (!stockRequest) throw new NotFoundException('Stock request not found');
      if (requesterOnly && stockRequest.requested_by_user_id !== actorUserId)
        throw new ForbiddenException(
          'Only the requesting user can cancel this stock request',
        );
      if (stockRequest.status !== 'PENDING')
        throw new ConflictException(
          'Stock request cannot be changed in its current state',
        );

      await transaction
        .updateTable('stock_requests')
        .set({ status, updated_at: sql<Date>`now()` })
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto('stock_request_events')
        .values({
          stock_request_id: id,
          event_type: status,
          actor_user_id: actorUserId,
        })
        .execute();

      const details = await this.findDetails(transaction, id);
      if (!details) throw new NotFoundException('Stock request not found');
      return details;
    });
  }

  private async findDetails(executor: DbExecutor, id: string) {
    const stockRequest = await executor
      .selectFrom('stock_requests as sr')
      .innerJoin('branches as b', 'b.id', 'sr.branch_id')
      .innerJoin('auth.users as u', 'u.id', 'sr.requested_by_user_id')
      .select([
        'sr.id',
        'sr.branch_id',
        'b.branch_name',
        'sr.requested_by_user_id',
        'u.full_name as requester_name',
        'sr.status',
        'sr.created_at',
        'sr.updated_at',
      ])
      .where('sr.id', '=', id)
      .executeTakeFirst();
    if (!stockRequest) return undefined;

    const [items, events] = await Promise.all([
      executor
        .selectFrom('stock_request_items as sri')
        .innerJoin('stock_items as si', 'si.id', 'sri.stock_item_id')
        .select([
          'sri.id',
          'sri.stock_item_id',
          'si.stock_item_name',
          'si.unit',
          sql<string>`sri.quantity_requested::text`.as('quantity_requested'),
          'sri.created_at',
        ])
        .where('sri.stock_request_id', '=', id)
        .orderBy('si.stock_item_name')
        .orderBy('sri.id')
        .execute(),
      executor
        .selectFrom('stock_request_events as sre')
        .innerJoin('auth.users as u', 'u.id', 'sre.actor_user_id')
        .select([
          'sre.id',
          'sre.event_type',
          'sre.actor_user_id',
          'u.full_name as actor_name',
          'sre.created_at',
        ])
        .where('sre.stock_request_id', '=', id)
        .orderBy('sre.created_at')
        .orderBy('sre.id')
        .execute(),
    ]);

    return { ...stockRequest, items, events };
  }

  private findByIdempotencyKey(executor: DbExecutor, key: string) {
    return executor
      .selectFrom('stock_requests')
      .select(['id', 'branch_id', 'requested_by_user_id'])
      .where('idempotency_key', '=', key)
      .executeTakeFirst();
  }

  private async returnForRetry(
    executor: DbExecutor,
    existing: {
      id: string;
      branch_id: string;
      requested_by_user_id: string;
    },
    input: CreateStockRequestInput,
  ) {
    const existingItems = await executor
      .selectFrom('stock_request_items')
      .select(['stock_item_id', 'quantity_requested'])
      .where('stock_request_id', '=', existing.id)
      .execute();
    const sameRequest =
      existing.branch_id === input.branch_id &&
      existing.requested_by_user_id === input.requested_by_user_id &&
      this.itemFingerprint(existingItems) === this.itemFingerprint(input.items);
    if (!sameRequest)
      throw new ConflictException(
        'Idempotency key was already used for another stock request',
      );

    const details = await this.findDetails(executor, existing.id);
    if (!details) throw new NotFoundException('Stock request not found');
    return details;
  }

  private itemFingerprint(
    items: Array<{
      stock_item_id: string;
      quantity_requested: string | number;
    }>,
  ) {
    return items
      .map((item) =>
        [
          item.stock_item_id,
          this.normalizeDecimal(item.quantity_requested),
        ].join(':'),
      )
      .sort()
      .join('|');
  }

  private normalizeDecimal(value: string | number) {
    const decimal = String(value);
    const [wholePart, fractionPart = ''] = decimal.split('.');
    const whole = wholePart.replace(/^0+(?=\d)/, '');
    const fraction = fractionPart.replace(/0+$/, '');
    return `${whole}${fraction ? `.${fraction}` : ''}`;
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
