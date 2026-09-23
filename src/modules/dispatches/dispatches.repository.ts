import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { sql, type Kysely, type Transaction } from 'kysely';
import { DATABASE } from '../../database/database.module';
import type { DB } from '../../database/db';
import type { DispatchQueryDto } from './dto/dispatch-query.dto';
import type {
  DispatchDbExecutor,
  DispatchEvent,
  DispatchItemInput,
  DispatchStatus,
  ScopedActionInput,
} from './dispatches.types';
import { normalizeDecimal } from './dispatches.repository.utils';

type DbExecutor = DispatchDbExecutor;

@Injectable()
export class DispatchesRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DB>) {}

  findRequestForDispatch(id: string) {
    return this.db
      .selectFrom('stock_requests')
      .select(['branch_id', 'status'])
      .where('id', '=', id)
      .executeTakeFirst();
  }

  async list(query: DispatchQueryDto, branchIds: string[] | null) {
    let records = this.db
      .selectFrom('dispatches as d')
      .innerJoin('branches as b', 'b.id', 'd.branch_id')
      .innerJoin('stock_requests as sr', 'sr.id', 'd.stock_request_id')
      .innerJoin('auth.users as creator', 'creator.id', 'd.created_by_user_id')
      .leftJoin(
        'auth.users as dispatcher',
        'dispatcher.id',
        'd.dispatched_by_user_id',
      )
      .select([
        'd.id',
        'd.stock_request_id',
        'd.branch_id',
        'b.branch_name',
        'sr.status as stock_request_status',
        'd.status',
        'd.created_by_user_id',
        'creator.full_name as created_by_name',
        'd.dispatched_by_user_id',
        'dispatcher.full_name as dispatched_by_name',
        'd.dispatched_at',
        'd.created_at',
        'd.updated_at',
        sql<number>`(select count(*)::int from dispatch_items as di where di.dispatch_id = d.id)`.as(
          'item_count',
        ),
      ])
      .orderBy('d.created_at', 'desc')
      .orderBy('d.id', 'desc')
      .limit(query.page_size)
      .offset((query.page - 1) * query.page_size);
    let count = this.db
      .selectFrom('dispatches as d')
      .select((eb) => eb.fn.countAll<number>().as('total'));

    if (branchIds !== null) {
      records = records.where('d.branch_id', 'in', branchIds);
      count = count.where('d.branch_id', 'in', branchIds);
    }
    if (query.branch_id) {
      records = records.where('d.branch_id', '=', query.branch_id);
      count = count.where('d.branch_id', '=', query.branch_id);
    }
    if (query.status) {
      records = records.where('d.status', '=', query.status);
      count = count.where('d.status', '=', query.status);
    }

    const [items, result] = await Promise.all([
      records.execute(),
      count.executeTakeFirstOrThrow(),
    ]);
    return {
      items,
      total: Number(result.total),
      page: query.page,
      page_size: query.page_size,
    };
  }

  findById(id: string) {
    return this.findDetails(this.db, id);
  }

  async findDetails(executor: DbExecutor, id: string) {
    const dispatch = await executor
      .selectFrom('dispatches as d')
      .innerJoin('branches as b', 'b.id', 'd.branch_id')
      .innerJoin('stock_requests as sr', 'sr.id', 'd.stock_request_id')
      .innerJoin('auth.users as creator', 'creator.id', 'd.created_by_user_id')
      .leftJoin(
        'auth.users as dispatcher',
        'dispatcher.id',
        'd.dispatched_by_user_id',
      )
      .select([
        'd.id',
        'd.stock_request_id',
        'd.branch_id',
        'b.branch_name',
        'sr.status as stock_request_status',
        'd.status',
        'd.idempotency_key',
        'd.created_by_user_id',
        'creator.full_name as created_by_name',
        'd.dispatched_by_user_id',
        'dispatcher.full_name as dispatched_by_name',
        'd.dispatched_at',
        'd.created_at',
        'd.updated_at',
      ])
      .where('d.id', '=', id)
      .executeTakeFirst();
    if (!dispatch) return undefined;

    const [items, receipts, shortageClosures, events] = await Promise.all([
      executor
        .selectFrom('dispatch_items as di')
        .innerJoin(
          'stock_request_items as sri',
          'sri.id',
          'di.stock_request_item_id',
        )
        .innerJoin('stock_items as si', 'si.id', 'sri.stock_item_id')
        .select([
          'di.id',
          'di.stock_request_item_id',
          'sri.stock_item_id',
          'si.stock_item_name',
          'si.unit',
          sql<string>`sri.quantity_requested::text`.as('quantity_requested'),
          sql<string>`di.quantity_dispatched::text`.as('quantity_dispatched'),
          sql<string>`coalesce((select sum(dri.quantity_received) from dispatch_receipt_items as dri where dri.dispatch_item_id = di.id), 0)::text`.as(
            'quantity_received',
          ),
          sql<string>`coalesce((select sum(dsci.quantity_closed) from dispatch_shortage_closure_items as dsci where dsci.dispatch_item_id = di.id), 0)::text`.as(
            'quantity_shortage_closed',
          ),
          sql<string>`(di.quantity_dispatched - coalesce((select sum(dri.quantity_received) from dispatch_receipt_items as dri where dri.dispatch_item_id = di.id), 0) - coalesce((select sum(dsci.quantity_closed) from dispatch_shortage_closure_items as dsci where dsci.dispatch_item_id = di.id), 0))::text`.as(
            'quantity_in_transit',
          ),
        ])
        .where('di.dispatch_id', '=', id)
        .orderBy('si.stock_item_name')
        .orderBy('di.id')
        .execute(),
      this.listReceiptDetails(executor, id),
      this.listShortageDetails(executor, id),
      executor
        .selectFrom('dispatch_events as de')
        .innerJoin('auth.users as actor', 'actor.id', 'de.actor_user_id')
        .select([
          'de.id',
          'de.event_type',
          'de.actor_user_id',
          'actor.full_name as actor_name',
          'de.dispatch_receipt_id',
          'de.shortage_closure_id',
          'de.created_at',
        ])
        .where('de.dispatch_id', '=', id)
        .orderBy('de.created_at')
        .orderBy('de.id')
        .execute(),
    ]);

    return {
      ...dispatch,
      items: items.map((item) => ({
        ...item,
        quantity_requested: normalizeDecimal(item.quantity_requested),
        quantity_dispatched: normalizeDecimal(item.quantity_dispatched),
        quantity_received: normalizeDecimal(item.quantity_received),
        quantity_shortage_closed: normalizeDecimal(
          item.quantity_shortage_closed,
        ),
        quantity_in_transit: normalizeDecimal(item.quantity_in_transit),
      })),
      receipts: receipts.map((receipt) => ({
        ...receipt,
        items: receipt.items.map((item) => ({
          ...item,
          quantity_received: normalizeDecimal(item.quantity_received),
        })),
      })),
      shortage_closures: shortageClosures.map((closure) => ({
        ...closure,
        items: closure.items.map((item) => ({
          ...item,
          quantity_closed: normalizeDecimal(item.quantity_closed),
        })),
      })),
      events,
    };
  }

  private async listReceiptDetails(executor: DbExecutor, dispatchId: string) {
    const rows = await executor
      .selectFrom('dispatch_receipts as dr')
      .innerJoin(
        'auth.users as receiver',
        'receiver.id',
        'dr.received_by_user_id',
      )
      .leftJoin(
        'dispatch_receipt_items as dri',
        'dri.dispatch_receipt_id',
        'dr.id',
      )
      .leftJoin('dispatch_items as di', 'di.id', 'dri.dispatch_item_id')
      .leftJoin(
        'stock_request_items as sri',
        'sri.id',
        'di.stock_request_item_id',
      )
      .leftJoin('stock_items as si', 'si.id', 'sri.stock_item_id')
      .select([
        'dr.id',
        'dr.received_by_user_id',
        'receiver.full_name as receiver_name',
        'dr.created_at',
        'dri.id as receipt_item_id',
        'di.id as dispatch_item_id',
        'sri.stock_item_id',
        'si.stock_item_name',
        'si.unit',
        sql<string>`dri.quantity_received::text`.as('quantity_received'),
      ])
      .where('dr.dispatch_id', '=', dispatchId)
      .orderBy('dr.created_at')
      .orderBy('dr.id')
      .orderBy('dri.id')
      .execute();

    const byId = new Map<
      string,
      {
        id: string;
        received_by_user_id: string;
        receiver_name: string;
        created_at: Date;
        items: Array<{
          receipt_item_id: string;
          dispatch_item_id: string;
          stock_item_id: string;
          stock_item_name: string;
          unit: string;
          quantity_received: string;
        }>;
      }
    >();
    for (const row of rows) {
      let receipt = byId.get(row.id);
      if (!receipt) {
        receipt = {
          id: row.id,
          received_by_user_id: row.received_by_user_id,
          receiver_name: row.receiver_name,
          created_at: row.created_at,
          items: [],
        };
        byId.set(row.id, receipt);
      }
      if (
        row.receipt_item_id &&
        row.dispatch_item_id &&
        row.stock_item_id &&
        row.stock_item_name &&
        row.unit &&
        row.quantity_received
      )
        receipt.items.push({
          receipt_item_id: row.receipt_item_id,
          dispatch_item_id: row.dispatch_item_id,
          stock_item_id: row.stock_item_id,
          stock_item_name: row.stock_item_name,
          unit: row.unit,
          quantity_received: row.quantity_received,
        });
    }
    return [...byId.values()];
  }

  private async listShortageDetails(executor: DbExecutor, dispatchId: string) {
    const rows = await executor
      .selectFrom('dispatch_shortage_closures as dsc')
      .innerJoin('auth.users as closer', 'closer.id', 'dsc.closed_by_user_id')
      .leftJoin(
        'dispatch_shortage_closure_items as dsci',
        'dsci.shortage_closure_id',
        'dsc.id',
      )
      .leftJoin('dispatch_items as di', 'di.id', 'dsci.dispatch_item_id')
      .leftJoin(
        'stock_request_items as sri',
        'sri.id',
        'di.stock_request_item_id',
      )
      .leftJoin('stock_items as si', 'si.id', 'sri.stock_item_id')
      .select([
        'dsc.id',
        'dsc.closed_by_user_id',
        'closer.full_name as closer_name',
        'dsc.reason',
        'dsc.created_at',
        'dsci.id as closure_item_id',
        'di.id as dispatch_item_id',
        'sri.stock_item_id',
        'si.stock_item_name',
        'si.unit',
        sql<string>`dsci.quantity_closed::text`.as('quantity_closed'),
      ])
      .where('dsc.dispatch_id', '=', dispatchId)
      .orderBy('dsc.created_at')
      .orderBy('dsc.id')
      .orderBy('dsci.id')
      .execute();

    const byId = new Map<
      string,
      {
        id: string;
        closed_by_user_id: string;
        closer_name: string;
        reason: string;
        created_at: Date;
        items: Array<{
          closure_item_id: string;
          dispatch_item_id: string;
          stock_item_id: string;
          stock_item_name: string;
          unit: string;
          quantity_closed: string;
        }>;
      }
    >();
    for (const row of rows) {
      let closure = byId.get(row.id);
      if (!closure) {
        closure = {
          id: row.id,
          closed_by_user_id: row.closed_by_user_id,
          closer_name: row.closer_name,
          reason: row.reason,
          created_at: row.created_at,
          items: [],
        };
        byId.set(row.id, closure);
      }
      if (
        row.closure_item_id &&
        row.dispatch_item_id &&
        row.stock_item_id &&
        row.stock_item_name &&
        row.unit &&
        row.quantity_closed
      )
        closure.items.push({
          closure_item_id: row.closure_item_id,
          dispatch_item_id: row.dispatch_item_id,
          stock_item_id: row.stock_item_id,
          stock_item_name: row.stock_item_name,
          unit: row.unit,
          quantity_closed: row.quantity_closed,
        });
    }
    return [...byId.values()];
  }

  async loadDispatchItems(executor: DbExecutor, dispatchId: string) {
    return executor
      .selectFrom('dispatch_items as di')
      .innerJoin(
        'stock_request_items as sri',
        'sri.id',
        'di.stock_request_item_id',
      )
      .select(['di.id', 'sri.stock_item_id', 'di.quantity_dispatched'])
      .where('di.dispatch_id', '=', dispatchId)
      .orderBy('sri.stock_item_id')
      .orderBy('di.id')
      .execute();
  }

  async hasRemainingQuantity(
    executor: DbExecutor,
    item: DispatchItemInput,
  ): Promise<boolean> {
    const amount = item.quantity;
    const remaining = await sql<{ allowed: boolean }>`
      SELECT di.quantity_dispatched
        - coalesce((
          SELECT sum(dri.quantity_received)
          FROM dispatch_receipt_items AS dri
          WHERE dri.dispatch_item_id = di.id
        ), 0)
        - coalesce((
          SELECT sum(dsci.quantity_closed)
          FROM dispatch_shortage_closure_items AS dsci
          WHERE dsci.dispatch_item_id = di.id
        ), 0)
        >= ${amount}::numeric AS allowed
      FROM dispatch_items AS di
      WHERE di.id = ${item.dispatch_item_id}
    `.execute(executor);
    return remaining.rows[0]?.allowed === true;
  }

  async refreshStatus(
    transaction: Transaction<DB>,
    dispatchId: string,
  ): Promise<void> {
    const summary = await sql<{
      all_resolved: boolean;
      has_receipts: boolean;
      has_shortages: boolean;
    }>`
      SELECT
        bool_and(
          di.quantity_dispatched =
            coalesce((
              SELECT sum(dri.quantity_received)
              FROM dispatch_receipt_items AS dri
              WHERE dri.dispatch_item_id = di.id
            ), 0)
            + coalesce((
              SELECT sum(dsci.quantity_closed)
              FROM dispatch_shortage_closure_items AS dsci
              WHERE dsci.dispatch_item_id = di.id
            ), 0)
        ) AS all_resolved,
        bool_or(coalesce((
          SELECT sum(dri.quantity_received)
          FROM dispatch_receipt_items AS dri
          WHERE dri.dispatch_item_id = di.id
        ), 0) > 0) AS has_receipts,
        bool_or(coalesce((
          SELECT sum(dsci.quantity_closed)
          FROM dispatch_shortage_closure_items AS dsci
          WHERE dsci.dispatch_item_id = di.id
        ), 0) > 0) AS has_shortages
      FROM dispatch_items AS di
      WHERE di.dispatch_id = ${dispatchId}
    `.execute(transaction);
    const state = summary.rows[0];
    if (!state) throw new BadRequestException('Dispatch has no items');
    let status: DispatchStatus;
    if (state.all_resolved)
      status = state.has_shortages ? 'CLOSED_WITH_SHORTAGE' : 'RECEIVED';
    else status = state.has_receipts ? 'PARTIALLY_RECEIVED' : 'IN_TRANSIT';
    await transaction
      .updateTable('dispatches')
      .set({ status, updated_at: sql<Date>`now()` })
      .where('id', '=', dispatchId)
      .executeTakeFirstOrThrow();
  }

  async findDispatchForUpdate(
    transaction: Transaction<DB>,
    id: string,
    branchIds: string[] | null,
  ) {
    let query = transaction
      .selectFrom('dispatches')
      .select(['id', 'branch_id', 'status'])
      .where('id', '=', id);
    if (branchIds !== null) query = query.where('branch_id', 'in', branchIds);
    return query.forUpdate().executeTakeFirst();
  }

  async requireActiveBranch(
    transaction: Transaction<DB>,
    branchId: string,
  ): Promise<void> {
    const branch = await transaction
      .selectFrom('branches')
      .select(['id', 'status'])
      .where('id', '=', branchId)
      .forUpdate()
      .executeTakeFirst();
    if (!branch || branch.status !== 'active')
      throw new NotFoundException('Active branch not found');
  }

  async findEventByIdempotencyKey(executor: DbExecutor, key: string) {
    return executor
      .selectFrom('dispatch_events')
      .select([
        'dispatch_id',
        'event_type',
        'actor_user_id',
        'dispatch_receipt_id',
        'shortage_closure_id',
      ])
      .where('idempotency_key', '=', key)
      .executeTakeFirst();
  }

  async returnForActionRetry(
    executor: DbExecutor,
    existing: DispatchEvent,
    input: ScopedActionInput,
    expectedType: string,
  ) {
    if (
      existing.dispatch_id !== input.id ||
      existing.actor_user_id !== input.actor_user_id ||
      existing.event_type !== expectedType
    )
      throw new ConflictException('Idempotency key was already used');
    const details = await this.findDetails(executor, input.id);
    if (!details) throw new NotFoundException('Dispatch not found');
    return details;
  }
}
