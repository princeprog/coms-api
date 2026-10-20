import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { sql, type Kysely, type Transaction } from 'kysely';
import { DATABASE } from '../../database/database.module';
import type { DB } from '../../database/db';
import {
  paginatedResult,
  paginationOffset,
} from '../../common/utils/pagination';
import { NotificationWriterRepository } from '../notifications/notification-writer.repository';
import type { ShiftQueryDto } from './dto/shift.dto';
import { salePaymentKind, shiftTotals } from './shift-register';

type Executor = Kysely<DB> | Transaction<DB>;

export type CloseInput = {
  branchId: string;
  shiftId: string;
  actorUserId: string;
  countedCash: string;
  leftInDrawer: string;
  idempotencyKey: string;
  forceReason?: string;
};

const money = (column: string) =>
  sql<string | null>`trim_scale(${sql.ref(column)})::text`;

@Injectable()
export class ShiftsRepository {
  constructor(
    @Inject(DATABASE) private readonly db: Kysely<DB>,
    private readonly notifications: NotificationWriterRepository,
  ) {}

  private shifts(executor: Executor) {
    return executor
      .selectFrom('register_shifts as shift')
      .innerJoin('branches as branch', 'branch.id', 'shift.branch_id')
      .innerJoin('auth.users as opener', 'opener.id', 'shift.opened_by_user_id')
      .leftJoin('auth.users as closer', 'closer.id', 'shift.closed_by_user_id')
      .leftJoin(
        'auth.users as reviewer',
        'reviewer.id',
        'shift.reviewed_by_user_id',
      )
      .select([
        'shift.id',
        'shift.branch_id',
        'branch.branch_name',
        sql<string>`shift.business_date::text`.as('business_date'),
        'shift.shift_number',
        'shift.status',
        'shift.opened_by_user_id',
        'opener.full_name as opened_by_name',
        'shift.opened_at',
        money('shift.opening_float').as('opening_float'),
        money('shift.expected_opening_float').as('expected_opening_float'),
        money('shift.opening_difference').as('opening_difference'),
        'shift.closed_by_user_id',
        'closer.full_name as closed_by_name',
        'shift.closed_at',
        'shift.close_type',
        'shift.force_close_reason',
        money('shift.counted_cash').as('counted_cash'),
        money('shift.left_in_drawer').as('left_in_drawer'),
        money('shift.expected_cash').as('expected_cash'),
        money('shift.cash_difference').as('cash_difference'),
        'shift.cashier_explanation',
        'shift.reviewed_by_user_id',
        'reviewer.full_name as reviewed_by_name',
        'shift.reviewed_at',
        'shift.review_note',
        sql<Date>`coms_business_day_end(shift.business_date)`.as(
          'business_day_ends_at',
        ),
        sql<boolean>`coms_business_day_end(shift.business_date) <= now()`.as(
          'business_day_ended',
        ),
        sql<number>`coalesce(shift.sales_count,
          (SELECT count(*)::int FROM sales WHERE sales.shift_id = shift.id))`.as(
          'sales_count',
        ),
      ]);
  }

  async current(branchId: string) {
    await this.requireBranch(this.db, branchId);
    const shift = await this.db
      .selectFrom('register_shifts')
      .select('id')
      .where('branch_id', '=', branchId)
      .where('status', '=', 'OPEN')
      .executeTakeFirst();
    return shift ? this.detail(this.db, branchId, shift.id) : null;
  }

  find(branchId: string, shiftId: string) {
    return this.detail(this.db, branchId, shiftId);
  }

  /** The open shift this user is running, at any branch they can access. */
  async currentForUser(userId: string, branchIds: string[] | null) {
    let query = this.db
      .selectFrom('register_shifts')
      .select(['id', 'branch_id'])
      .where('opened_by_user_id', '=', userId)
      .where('status', '=', 'OPEN');
    if (branchIds)
      query = query.where(
        'branch_id',
        'in',
        branchIds.length ? branchIds : [sql<string>`NULL`],
      );
    const shift = await query
      .orderBy('opened_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    return shift ? this.detail(this.db, shift.branch_id, shift.id) : null;
  }

  async list(branchId: string, query: ShiftQueryDto) {
    await this.requireBranch(this.db, branchId);
    let filtered = this.db
      .selectFrom('register_shifts as shift')
      .where('shift.branch_id', '=', branchId);
    if (query.status)
      filtered = filtered.where('shift.status', '=', query.status);
    if (query.date_from)
      filtered = filtered.where(
        'shift.business_date',
        '>=',
        sql<Date>`${query.date_from}::date`,
      );
    if (query.date_to)
      filtered = filtered.where(
        'shift.business_date',
        '<=',
        sql<Date>`${query.date_to}::date`,
      );
    const ids = filtered.select('shift.id');
    const [items, total] = await Promise.all([
      this.shifts(this.db)
        .where('shift.id', 'in', ids)
        .orderBy('shift.business_date', 'desc')
        .orderBy('shift.shift_number', 'desc')
        .limit(query.page_size)
        .offset(paginationOffset(query))
        .execute(),
      filtered
        .select(sql<number>`count(*)::int`.as('total'))
        .executeTakeFirstOrThrow(),
    ]);
    return paginatedResult(items, total.total, query);
  }

  async open(input: {
    branchId: string;
    actorUserId: string;
    openingFloat: string;
    idempotencyKey: string;
  }) {
    try {
      return await this.db.transaction().execute(async (transaction) => {
        const retry = await this.openRetry(transaction, input);
        if (retry) return retry;
        // Serializes opens per branch; sales hold a share lock on the same row.
        const branch = await transaction
          .selectFrom('branches')
          .select(['id', 'status'])
          .where('id', '=', input.branchId)
          .forUpdate()
          .executeTakeFirst();
        if (!branch || branch.status !== 'active')
          throw new NotFoundException('Active branch not found');
        const open = await transaction
          .selectFrom('register_shifts as shift')
          .innerJoin('auth.users as u', 'u.id', 'shift.opened_by_user_id')
          .select(['shift.id', 'u.full_name'])
          .where('shift.branch_id', '=', input.branchId)
          .where('shift.status', '=', 'OPEN')
          .executeTakeFirst();
        if (open)
          throw new ConflictException({
            code: 'SHIFT_ALREADY_OPEN',
            message: `${open.full_name}'s shift is still open. It must be closed first.`,
          });
        const previous = await transaction
          .selectFrom('register_shifts')
          .select(money('left_in_drawer').as('left_in_drawer'))
          .where('branch_id', '=', input.branchId)
          .where('status', '<>', 'OPEN')
          .orderBy('closed_at', 'desc')
          .orderBy('id', 'desc')
          .limit(1)
          .executeTakeFirst();
        const expected = previous?.left_in_drawer ?? null;
        const inserted = await sql<{ id: string }>`
          WITH day AS (SELECT coms_business_date(now()) AS d)
          INSERT INTO register_shifts (
            branch_id, business_date, shift_number, opened_by_user_id,
            opening_float, expected_opening_float, opening_difference, open_idempotency_key
          )
          SELECT ${input.branchId}::uuid, day.d,
            coalesce((SELECT max(shift_number) FROM register_shifts
              WHERE branch_id = ${input.branchId}::uuid AND business_date = day.d), 0) + 1,
            ${input.actorUserId}::uuid, ${input.openingFloat}::numeric, ${expected}::numeric,
            ${input.openingFloat}::numeric - ${expected}::numeric,
            ${input.idempotencyKey}::uuid
          FROM day
          RETURNING id
        `.execute(transaction);
        return this.detail(transaction, input.branchId, inserted.rows[0]!.id);
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const retry = await this.openRetry(this.db, input);
      if (retry) return retry;
      throw new ConflictException({
        code: 'SHIFT_ALREADY_OPEN',
        message:
          'Another shift was opened at the same time. Refresh to continue.',
      });
    }
  }

  async addCashMovement(input: {
    branchId: string;
    shiftId: string;
    actorUserId: string;
    canReview: boolean;
    direction: 'IN' | 'OUT';
    amount: string;
    reason: string;
    idempotencyKey: string;
  }) {
    try {
      return await this.db.transaction().execute(async (transaction) => {
        const retry = await this.movementRetry(transaction, input);
        if (retry) return retry;
        const shift = await this.lockShift(
          transaction,
          input.branchId,
          input.shiftId,
        );
        if (shift.status !== 'OPEN')
          throw new ConflictException('This shift is already closed');
        if (!input.canReview && shift.opened_by_user_id !== input.actorUserId)
          throw new ForbiddenException(
            'Only the cashier on this shift or a reviewer can record cash in or out',
          );
        await transaction
          .insertInto('register_shift_cash_movements')
          .values({
            shift_id: input.shiftId,
            direction: input.direction,
            amount: input.amount,
            reason: input.reason,
            actor_user_id: input.actorUserId,
            idempotency_key: input.idempotencyKey,
          })
          .execute();
        return this.detail(transaction, input.branchId, input.shiftId);
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const retry = await this.movementRetry(this.db, input);
      if (retry) return retry;
      throw error;
    }
  }

  close(input: CloseInput) {
    return this.db.transaction().execute(async (transaction) => {
      const keyed = await transaction
        .selectFrom('register_shifts')
        .select('id')
        .where('close_idempotency_key', '=', input.idempotencyKey)
        .executeTakeFirst();
      if (keyed && keyed.id !== input.shiftId)
        throw new ConflictException(
          'Idempotency key has already been used for another shift',
        );
      const shift = await this.lockShift(
        transaction,
        input.branchId,
        input.shiftId,
      );
      if (shift.close_idempotency_key === input.idempotencyKey) {
        if (
          shift.counted_cash !== normalize(input.countedCash) ||
          shift.left_in_drawer !== normalize(input.leftInDrawer) ||
          shift.closed_by_user_id !== input.actorUserId
        )
          throw new ConflictException(
            'Idempotency key has already been used for a different count',
          );
        return this.detail(transaction, input.branchId, input.shiftId);
      }
      if (shift.status !== 'OPEN')
        throw new ConflictException('This shift is already closed');
      if (!input.forceReason && shift.opened_by_user_id !== input.actorUserId)
        throw new ForbiddenException(
          'Only the cashier who opened this shift can close it. A manager can force-close it.',
        );
      if (Number(input.leftInDrawer) > Number(input.countedCash))
        throw new BadRequestException(
          'Cash left in the drawer cannot be more than the counted cash',
        );
      const totals = await shiftTotals(transaction, input.shiftId);
      const closed = await transaction
        .updateTable('register_shifts')
        .set({
          status: 'CLOSED',
          closed_by_user_id: input.actorUserId,
          closed_at: sql<Date>`now()`,
          close_type: input.forceReason ? 'FORCED' : 'CASHIER',
          force_close_reason: input.forceReason ?? null,
          close_idempotency_key: input.idempotencyKey,
          counted_cash: input.countedCash,
          left_in_drawer: input.leftInDrawer,
          expected_cash: totals.expected_cash,
          cash_difference: sql<string>`${input.countedCash}::numeric - ${totals.expected_cash}::numeric`,
          cash_sales_amount: totals.cash_sales_amount,
          non_cash_sales_amount: totals.non_cash_sales_amount,
          cash_refunds_amount: totals.cash_refunds_amount,
          cash_in_amount: totals.cash_in_amount,
          cash_out_amount: totals.cash_out_amount,
          sales_count: totals.sales_count,
          voids_count: totals.voids_count,
          updated_at: sql<Date>`now()`,
        })
        .where('id', '=', input.shiftId)
        .where('status', '=', 'OPEN')
        .returning([
          sql<boolean>`cash_difference <> 0 OR coalesce(opening_difference, 0) <> 0`.as(
            'has_difference',
          ),
        ])
        .executeTakeFirstOrThrow();
      if (closed.has_difference || input.forceReason)
        await this.notifications.publish(transaction, {
          kind: 'SHIFT_NEEDS_REVIEW',
          shift_id: input.shiftId,
          branch_id: input.branchId,
          actor_user_id: input.actorUserId,
        });
      return this.detail(transaction, input.branchId, input.shiftId);
    });
  }

  explain(input: {
    branchId: string;
    shiftId: string;
    actorUserId: string;
    explanation: string;
  }) {
    return this.db.transaction().execute(async (transaction) => {
      const shift = await this.lockShift(
        transaction,
        input.branchId,
        input.shiftId,
      );
      if (shift.opened_by_user_id !== input.actorUserId)
        throw new ForbiddenException(
          'Only the cashier on this shift can add an explanation',
        );
      if (shift.cashier_explanation !== null) {
        if (shift.cashier_explanation === input.explanation)
          return this.detail(transaction, input.branchId, input.shiftId);
        throw new ConflictException('An explanation was already added');
      }
      if (shift.status !== 'CLOSED')
        throw new ConflictException(
          'Explanations can be added after closing and before review',
        );
      await transaction
        .updateTable('register_shifts')
        .set({
          cashier_explanation: input.explanation,
          updated_at: sql<Date>`now()`,
        })
        .where('id', '=', input.shiftId)
        .execute();
      return this.detail(transaction, input.branchId, input.shiftId);
    });
  }

  review(input: {
    branchId: string;
    shiftId: string;
    actorUserId: string;
    superAdmin: boolean;
    note: string | null;
  }) {
    return this.db.transaction().execute(async (transaction) => {
      const shift = await this.lockShift(
        transaction,
        input.branchId,
        input.shiftId,
      );
      if (shift.status === 'REVIEWED') {
        if (
          shift.reviewed_by_user_id === input.actorUserId &&
          shift.review_note === input.note
        )
          return this.detail(transaction, input.branchId, input.shiftId);
        throw new ConflictException('This shift was already reviewed');
      }
      if (shift.status !== 'CLOSED')
        throw new ConflictException('Close this shift before reviewing it');
      if (!input.superAdmin && shift.opened_by_user_id === input.actorUserId)
        throw new ForbiddenException(
          'Another manager must review a shift you worked',
        );
      if (shift.has_difference && !input.note)
        throw new BadRequestException(
          'Add a review note explaining the cash difference',
        );
      await transaction
        .updateTable('register_shifts')
        .set({
          status: 'REVIEWED',
          reviewed_by_user_id: input.actorUserId,
          reviewed_at: sql<Date>`now()`,
          review_note: input.note,
          updated_at: sql<Date>`now()`,
        })
        .where('id', '=', input.shiftId)
        .execute();
      return this.detail(transaction, input.branchId, input.shiftId);
    });
  }

  private async detail(executor: Executor, branchId: string, shiftId: string) {
    const shift = await this.shifts(executor)
      .where('shift.id', '=', shiftId)
      .where('shift.branch_id', '=', branchId)
      .executeTakeFirst();
    if (!shift) throw new NotFoundException('Shift not found');
    const [totals, payments, cash_movements, voids] = await Promise.all([
      shift.status === 'OPEN'
        ? shiftTotals(executor, shiftId)
        : executor
            .selectFrom('register_shifts')
            .select([
              money('cash_sales_amount').as('cash_sales_amount'),
              money('non_cash_sales_amount').as('non_cash_sales_amount'),
              money('cash_refunds_amount').as('cash_refunds_amount'),
              money('cash_in_amount').as('cash_in_amount'),
              money('cash_out_amount').as('cash_out_amount'),
              money('expected_cash').as('expected_cash'),
              sql<number>`coalesce(sales_count, 0)`.as('sales_count'),
              sql<number>`coalesce(voids_count, 0)`.as('voids_count'),
            ])
            .where('id', '=', shiftId)
            .executeTakeFirstOrThrow(),
      sql<{
        tender_method: string;
        payment_kind: string;
        sales_count: number;
        amount: string;
      }>`
        SELECT s.tender_method, s.payment_kind, count(*)::int AS sales_count,
          trim_scale(sum(s.total_amount))::text AS amount
        FROM sales AS s
        WHERE s.shift_id = ${shiftId} AND s.status = 'COMPLETED'
        GROUP BY s.tender_method, s.payment_kind
        ORDER BY s.payment_kind, s.tender_method
      `.execute(executor),
      executor
        .selectFrom('register_shift_cash_movements as m')
        .innerJoin('auth.users as u', 'u.id', 'm.actor_user_id')
        .select([
          'm.id',
          'm.direction',
          money('m.amount').as('amount'),
          'm.reason',
          'u.full_name as actor_name',
          'm.created_at',
        ])
        .where('m.shift_id', '=', shiftId)
        .orderBy('m.created_at')
        .orderBy('m.id')
        .execute(),
      sql<{
        sale_id: string;
        sale_reference: string;
        amount: string;
        payment_kind: string;
        reason: string | null;
        actor_name: string;
        created_at: Date;
      }>`
        SELECT s.id AS sale_id, 'S-' || lpad(s.sale_number::text, 6, '0') AS sale_reference,
          trim_scale(s.total_amount)::text AS amount, ${salePaymentKind} AS payment_kind,
          e.reason, u.full_name AS actor_name, e.created_at
        FROM sale_events AS e
        JOIN sales AS s ON s.id = e.sale_id
        LEFT JOIN payment_methods AS pm ON pm.id = s.payment_method_id
        JOIN auth.users AS u ON u.id = e.actor_user_id
        WHERE e.refund_shift_id = ${shiftId} AND e.event_type = 'VOIDED'
        ORDER BY e.created_at, e.id
      `.execute(executor),
    ]);
    return {
      ...shift,
      totals,
      payments: payments.rows,
      cash_movements,
      voids: voids.rows,
    };
  }

  private async lockShift(
    transaction: Transaction<DB>,
    branchId: string,
    shiftId: string,
  ) {
    const shift = await transaction
      .selectFrom('register_shifts')
      .select([
        'id',
        'status',
        'opened_by_user_id',
        'closed_by_user_id',
        'close_idempotency_key',
        money('counted_cash').as('counted_cash'),
        money('left_in_drawer').as('left_in_drawer'),
        'cashier_explanation',
        'reviewed_by_user_id',
        'review_note',
        sql<boolean>`coalesce(cash_difference, 0) <> 0 OR coalesce(opening_difference, 0) <> 0`.as(
          'has_difference',
        ),
      ])
      .where('id', '=', shiftId)
      .where('branch_id', '=', branchId)
      .forUpdate()
      .executeTakeFirst();
    if (!shift) throw new NotFoundException('Shift not found');
    return shift;
  }

  private async openRetry(
    executor: Executor,
    input: {
      branchId: string;
      actorUserId: string;
      openingFloat: string;
      idempotencyKey: string;
    },
  ) {
    const existing = await executor
      .selectFrom('register_shifts')
      .select([
        'id',
        'branch_id',
        'opened_by_user_id',
        money('opening_float').as('opening_float'),
      ])
      .where('open_idempotency_key', '=', input.idempotencyKey)
      .executeTakeFirst();
    if (!existing) return null;
    if (
      existing.branch_id !== input.branchId ||
      existing.opened_by_user_id !== input.actorUserId ||
      existing.opening_float !== normalize(input.openingFloat)
    )
      throw new ConflictException(
        'Idempotency key has already been used for another shift',
      );
    return this.detail(executor, input.branchId, existing.id);
  }

  private async movementRetry(
    executor: Executor,
    input: {
      branchId: string;
      shiftId: string;
      actorUserId: string;
      direction: 'IN' | 'OUT';
      amount: string;
      reason: string;
      idempotencyKey: string;
    },
  ) {
    const existing = await executor
      .selectFrom('register_shift_cash_movements')
      .select([
        'shift_id',
        'actor_user_id',
        'direction',
        'reason',
        money('amount').as('amount'),
      ])
      .where('idempotency_key', '=', input.idempotencyKey)
      .executeTakeFirst();
    if (!existing) return null;
    if (
      existing.shift_id !== input.shiftId ||
      existing.actor_user_id !== input.actorUserId ||
      existing.direction !== input.direction ||
      existing.reason !== input.reason ||
      existing.amount !== normalize(input.amount)
    )
      throw new ConflictException(
        'Idempotency key has already been used for another cash movement',
      );
    return this.detail(executor, input.branchId, input.shiftId);
  }

  private async requireBranch(executor: Executor, branchId: string) {
    const branch = await executor
      .selectFrom('branches')
      .select('id')
      .where('id', '=', branchId)
      .executeTakeFirst();
    if (!branch) throw new NotFoundException('Branch not found');
  }
}

/** Matches PostgreSQL trim_scale text for stored peso amounts. */
function normalize(value: string) {
  const [whole, fraction = ''] = value.split('.');
  const trimmed = fraction.replace(/0+$/, '');
  return `${whole.replace(/^0+(?=\d)/, '')}${trimmed ? `.${trimmed}` : ''}`;
}

function isUniqueViolation(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505'
  );
}
