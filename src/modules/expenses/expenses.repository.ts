import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely, type Transaction } from 'kysely';
import { DATABASE } from '../../database/database.module';
import type { DB } from '../../database/db';
import type {
  ExpenseAccess,
  ExpenseExecutor,
  ExpenseInput,
  ExpenseRecord,
} from './expense.types';
import type { CashOutQueryDto } from './dto/expense.dto';
import { containsSearchPattern } from '../../common/utils/list-filters';
import { recordAudit, type AuditEventInput } from '../audit/audit-recorder';

export type SavedExpenseRequest = {
  expense_id: string;
  actor_user_id: string;
  request_payload: Record<string, unknown>;
  before_values: ExpenseRecord | null;
  after_values: ExpenseRecord;
};
export type CashOut = {
  id: string;
  shift_id: string;
  shift_number: number;
  business_date: string;
  amount: string;
  reason: string;
  actor_name: string;
  created_at: string;
};

@Injectable()
export class ExpensesRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DB>) {}

  transaction<T>(work: (tx: Transaction<DB>) => Promise<T>) {
    return this.db.transaction().execute(work);
  }

  async assignedBranches(userId: string) {
    const rows = await this.db
      .selectFrom('coms_auth.branch_users')
      .select('branch_id')
      .where('user_id', '=', userId)
      .execute();
    return rows.map((row) => row.branch_id);
  }

  async locations(access: ExpenseAccess) {
    const result = await sql<{
      scope: 'COMMISSARY' | 'BRANCH';
      branch_id: string | null;
      name: string;
      is_active: boolean;
    }>`
      SELECT 'COMMISSARY' AS scope, NULL::uuid AS branch_id, 'Commissary' AS name, true AS is_active WHERE ${access.commissary}
      UNION ALL
      SELECT 'BRANCH', id, branch_name, status = 'active' FROM branches
      WHERE ${access.branchIds === null} OR id = ANY(${access.branchIds ?? []}::uuid[])
      ORDER BY scope DESC, name, branch_id
    `.execute(this.db);
    return { items: result.rows };
  }

  async lockRequest(tx: Transaction<DB>, key: string) {
    // Serialize identical keys before reading their committed event; unlike a
    // read-then-insert race, no unique violation aborts the successful retry.
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`expense:${key}`}, 0))`.execute(
      tx,
    );
    const result = await sql<SavedExpenseRequest>`
      SELECT expense_id, actor_user_id, request_payload, before_values, after_values
      FROM expense_events WHERE idempotency_key = ${key}::uuid
    `.execute(tx);
    return result.rows[0];
  }

  async lockExpense(tx: Transaction<DB>, id: string) {
    return tx
      .selectFrom('expenses')
      .select('id')
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
  }

  category(tx: ExpenseExecutor, id: string) {
    return tx
      .selectFrom('expense_categories')
      .select(['id', 'is_active'])
      .where('id', '=', id)
      .forShare()
      .executeTakeFirst();
  }

  branch(tx: ExpenseExecutor, id: string) {
    return tx
      .selectFrom('branches')
      .select(['id', 'status'])
      .where('id', '=', id)
      .forShare()
      .executeTakeFirst();
  }

  async cashMovement(tx: Transaction<DB>, id: string) {
    const result = await sql<{
      id: string;
      amount: string;
      direction: string;
      branch_id: string;
      opened_by_user_id: string;
    }>`
      SELECT m.id, m.amount::text, m.direction, s.branch_id, s.opened_by_user_id
      FROM register_shift_cash_movements m JOIN register_shifts s ON s.id = m.shift_id
      WHERE m.id = ${id}::uuid FOR UPDATE OF m
    `.execute(tx);
    return result.rows[0];
  }

  activeCashLink(tx: Transaction<DB>, id: string) {
    return tx
      .selectFrom('expenses')
      .select('id')
      .where('cash_movement_id', '=', id)
      .where('status', '=', 'RECORDED')
      .executeTakeFirst();
  }

  async cashOuts(query: CashOutQueryDto, userId: string, canReview: boolean) {
    const search = query.search ? containsSearchPattern(query.search) : null;
    const result = await sql<{ items: CashOut[]; total: number }>`
      WITH eligible AS MATERIALIZED (
        SELECT m.id, m.shift_id, s.shift_number, s.business_date, m.amount,
          m.reason, u.full_name AS actor_name, m.created_at
        FROM register_shift_cash_movements m JOIN register_shifts s ON s.id = m.shift_id
        JOIN coms_auth.users u ON u.id = m.actor_user_id
        WHERE s.branch_id = ${query.branch_id}::uuid AND m.direction = 'OUT'
          AND (${canReview} OR s.opened_by_user_id = ${userId}::uuid)
          AND NOT EXISTS (SELECT 1 FROM expenses e WHERE e.cash_movement_id = m.id AND e.status = 'RECORDED')
          AND (${search}::text IS NULL OR concat_ws(' ', m.reason, u.full_name, s.shift_number::text, s.business_date::text, m.amount::text) ILIKE ${search}::text)
      ), page_rows AS (
        SELECT * FROM eligible ORDER BY created_at DESC, id
        LIMIT ${query.page_size} OFFSET ${(query.page - 1) * query.page_size}
      )
      SELECT coalesce((SELECT jsonb_agg(to_jsonb(p) || jsonb_build_object('amount', p.amount::text) ORDER BY p.created_at DESC, p.id) FROM page_rows p), '[]'::jsonb) AS items,
        (SELECT count(*)::int FROM eligible) AS total
    `.execute(this.db);
    return { ...result.rows[0], page: query.page, page_size: query.page_size };
  }

  async insert(tx: Transaction<DB>, input: ExpenseInput, userId: string) {
    const { scope, ...values } = input;
    return tx
      .insertInto('expenses')
      .values({
        ...values,
        expense_date: sql`${input.expense_date}::date`,
        inventory_scope: scope,
        created_by_user_id: userId,
        updated_by_user_id: userId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
  }

  update(tx: Transaction<DB>, id: string, input: ExpenseInput, userId: string) {
    const { scope, ...values } = input;
    return tx
      .updateTable('expenses')
      .set({
        ...values,
        inventory_scope: scope,
        expense_date: sql`${input.expense_date}::date`,
        revision: sql`revision + 1`,
        updated_at: sql`clock_timestamp()`,
        updated_by_user_id: userId,
      })
      .where('id', '=', id)
      .execute();
  }

  void(tx: Transaction<DB>, id: string, userId: string) {
    return tx
      .updateTable('expenses')
      .set({
        status: 'VOIDED',
        revision: sql`revision + 1`,
        updated_at: sql`clock_timestamp()`,
        updated_by_user_id: userId,
      })
      .where('id', '=', id)
      .execute();
  }

  async event(
    tx: Transaction<DB>,
    input: {
      action: 'CREATED' | 'UPDATED' | 'VOIDED';
      key: string;
      payload: Record<string, unknown>;
      reason: string | null;
      userId: string;
      before: ExpenseRecord | null;
      after: ExpenseRecord;
    },
  ) {
    await tx
      .insertInto('expense_events')
      .values({
        expense_id: input.after.id,
        action: input.action,
        idempotency_key: input.key,
        actor_user_id: input.userId,
        reason: input.reason,
        request_payload: JSON.stringify(input.payload),
        before_values: input.before ? JSON.stringify(input.before) : null,
        after_values: JSON.stringify(input.after),
      })
      .execute();
  }

  audit(tx: Transaction<DB>, input: AuditEventInput) {
    return recordAudit(tx, input);
  }
}
