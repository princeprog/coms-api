import {
  paginatedResult,
  paginationOffset,
} from '../../common/utils/pagination';
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

  findActiveBranch(id: string) {
    return this.db
      .selectFrom('branches')
      .select(['id', 'status'])
      .where('id', '=', id)
      .where('status', '=', 'active')
      .executeTakeFirst();
  }

  async list(query: DispatchQueryDto, branchIds: string[] | null) {
    let records = this.db
      .selectFrom('dispatches as d')
      .innerJoin('branches as b', 'b.id', 'd.branch_id')
      .innerJoin('auth.users as creator', 'creator.id', 'd.created_by_user_id')
      .leftJoin(
        'auth.users as dispatcher',
        'dispatcher.id',
        'd.dispatched_by_user_id',
      )
      .select([
        'd.id',
        'd.branch_id',
        'b.branch_name',
        'd.status',
        'd.created_by_user_id',
        'creator.full_name as created_by_name',
        'd.dispatched_by_user_id',
        'dispatcher.full_name as dispatched_by_name',
        'd.dispatched_at',
        'd.created_at',
        'd.updated_at',
        sql<string | null>`(
          SELECT dd.status
          FROM dispatch_discrepancies AS dd
          WHERE dd.dispatch_id = d.id
          ORDER BY dd.reported_at DESC, dd.id DESC
          LIMIT 1
        )`.as('discrepancy_status'),
        sql<number>`(select count(*)::int from dispatch_items as di where di.dispatch_id = d.id)`.as(
          'item_count',
        ),
      ])
      .orderBy('d.created_at', 'desc')
      .orderBy('d.id', 'desc')
      .limit(query.page_size)
      .offset(paginationOffset(query));
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
    if (query.discrepancy_status === 'NONE') {
      records = records.where(
        sql<boolean>`NOT EXISTS (
          SELECT 1 FROM dispatch_discrepancies AS dd
          WHERE dd.dispatch_id = d.id
        )`,
        '=',
        true,
      );
      count = count.where(
        sql<boolean>`NOT EXISTS (
          SELECT 1 FROM dispatch_discrepancies AS dd
          WHERE dd.dispatch_id = d.id
        )`,
        '=',
        true,
      );
    } else if (query.discrepancy_status) {
      records = records.where(
        sql<boolean>`EXISTS (
          SELECT 1 FROM dispatch_discrepancies AS dd
          WHERE dd.dispatch_id = d.id AND dd.status = ${query.discrepancy_status}
        )`,
        '=',
        true,
      );
      count = count.where(
        sql<boolean>`EXISTS (
          SELECT 1 FROM dispatch_discrepancies AS dd
          WHERE dd.dispatch_id = d.id AND dd.status = ${query.discrepancy_status}
        )`,
        '=',
        true,
      );
    }

    const [items, result] = await Promise.all([
      records.execute(),
      count.executeTakeFirstOrThrow(),
    ]);
    return paginatedResult(items, Number(result.total), query);
  }

  findById(id: string) {
    return this.findDetails(this.db, id);
  }

  async findDetails(executor: DbExecutor, id: string) {
    const dispatch = await executor
      .selectFrom('dispatches as d')
      .innerJoin('branches as b', 'b.id', 'd.branch_id')
      .innerJoin('auth.users as creator', 'creator.id', 'd.created_by_user_id')
      .leftJoin(
        'auth.users as dispatcher',
        'dispatcher.id',
        'd.dispatched_by_user_id',
      )
      .select([
        'd.id',
        'd.branch_id',
        'b.branch_name',
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

    const [
      items,
      receipts,
      shortageClosures,
      events,
      discrepancy,
      discrepancyEvents,
    ] = await Promise.all([
      executor
        .selectFrom('dispatch_items as di')
        .innerJoin('stock_items as si', 'si.id', 'di.stock_item_id')
        .select([
          'di.id',
          'di.stock_item_id',
          'si.stock_item_name',
          'si.unit',
          sql<string>`di.quantity_dispatched::text`.as('quantity_dispatched'),
          sql<string>`coalesce((select sum(dri.quantity_received) from dispatch_receipt_items as dri where dri.dispatch_item_id = di.id), 0)::text`.as(
            'quantity_received',
          ),
          sql<string>`coalesce((select sum(dsci.quantity_closed) from dispatch_shortage_closure_items as dsci where dsci.dispatch_item_id = di.id), 0)::text`.as(
            'quantity_shortage_closed',
          ),
          sql<string>`(CASE WHEN ${dispatch.status} = 'DRAFT' THEN 0 ELSE di.quantity_dispatched - coalesce((select sum(dri.quantity_received) from dispatch_receipt_items as dri where dri.dispatch_item_id = di.id), 0) - coalesce((select sum(dsci.quantity_closed) from dispatch_shortage_closure_items as dsci where dsci.dispatch_item_id = di.id), 0) END)::text`.as(
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
      sql<{
        id: string;
        status: 'OPEN' | 'RECOUNT_REQUESTED' | 'RESOLVED';
        reported_by_user_id: string;
        reported_by_name: string;
        reported_at: Date;
        recount_requested_by_user_id: string | null;
        recount_requested_by_name: string | null;
        recount_requested_at: Date | null;
        resolved_at: Date | null;
      }>`
        SELECT dd.id, dd.status, dd.reported_by_user_id,
               reporter.full_name AS reported_by_name, dd.reported_at,
               dd.recount_requested_by_user_id,
               recount_actor.full_name AS recount_requested_by_name,
               dd.recount_requested_at, dd.resolved_at
        FROM dispatch_discrepancies AS dd
        JOIN auth.users AS reporter ON reporter.id = dd.reported_by_user_id
        LEFT JOIN auth.users AS recount_actor
          ON recount_actor.id = dd.recount_requested_by_user_id
        WHERE dd.dispatch_id = ${id}
        ORDER BY dd.reported_at DESC, dd.id DESC
        LIMIT 1
      `
        .execute(executor)
        .then((result) => result.rows[0] ?? null),
      sql<{
        id: string;
        event_type: string;
        actor_user_id: string;
        actor_name: string;
        note: string;
        created_at: Date;
      }>`
        SELECT de.id, de.event_type, de.actor_user_id,
               actor.full_name AS actor_name, de.note, de.created_at
        FROM dispatch_discrepancy_events AS de
        JOIN dispatch_discrepancies AS dd ON dd.id = de.discrepancy_id
        JOIN auth.users AS actor ON actor.id = de.actor_user_id
        WHERE dd.dispatch_id = ${id}
        ORDER BY de.created_at, de.id
      `
        .execute(executor)
        .then((result) => result.rows),
    ]);

    return {
      ...dispatch,
      items: items.map((item) => ({
        ...item,
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
      discrepancy,
      discrepancy_events: discrepancyEvents,
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
      .leftJoin('stock_items as si', 'si.id', 'di.stock_item_id')
      .select([
        'dr.id',
        'dr.received_by_user_id',
        'receiver.full_name as receiver_name',
        'dr.created_at',
        'dri.id as receipt_item_id',
        'di.id as dispatch_item_id',
        'di.stock_item_id',
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
      .leftJoin('stock_items as si', 'si.id', 'di.stock_item_id')
      .select([
        'dsc.id',
        'dsc.closed_by_user_id',
        'closer.full_name as closer_name',
        'dsc.reason',
        'dsc.created_at',
        'dsci.id as closure_item_id',
        'di.id as dispatch_item_id',
        'di.stock_item_id',
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
      .select(['di.id', 'di.stock_item_id', 'di.quantity_dispatched'])
      .where('di.dispatch_id', '=', dispatchId)
      .orderBy('di.stock_item_id')
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
      .forNoKeyUpdate()
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
