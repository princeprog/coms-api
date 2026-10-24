import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely, type Transaction } from 'kysely';
import { DATABASE } from '../../database/database.module';
import type { DB } from '../../database/db';
import type { ExpenseCategory } from './expense.types';
import { recordAudit, type AuditEventInput } from '../audit/audit-recorder';

@Injectable()
export class ExpenseCategoriesRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DB>) {}
  transaction<T>(work: (tx: Transaction<DB>) => Promise<T>) {
    return this.db.transaction().execute(work);
  }
  async list() {
    const result = await sql<{
      category: ExpenseCategory;
    }>`SELECT to_jsonb(c) AS category FROM expense_categories c ORDER BY lower(name), id`.execute(
      this.db,
    );
    return { items: result.rows.map((row) => row.category) };
  }
  async lock(tx: Transaction<DB>, id: string) {
    const result = await sql<{
      category: ExpenseCategory;
    }>`SELECT to_jsonb(c) AS category FROM expense_categories c WHERE id = ${id}::uuid FOR UPDATE`.execute(
      tx,
    );
    return result.rows[0]?.category;
  }
  async create(tx: Transaction<DB>, name: string) {
    const result = await sql<{ category: ExpenseCategory }>`WITH inserted AS (
      INSERT INTO expense_categories (name) VALUES (${name}) RETURNING *
    ) SELECT to_jsonb(inserted) AS category FROM inserted`.execute(tx);
    return result.rows[0].category;
  }
  async update(
    tx: Transaction<DB>,
    id: string,
    input: { name?: string; is_active?: boolean },
  ) {
    const result = await sql<{ category: ExpenseCategory }>`WITH updated AS (
      UPDATE expense_categories SET name = coalesce(${input.name ?? null}::text, name),
        is_active = coalesce(${input.is_active ?? null}::boolean, is_active), updated_at = clock_timestamp()
      WHERE id = ${id}::uuid RETURNING *
    ) SELECT to_jsonb(updated) AS category FROM updated`.execute(tx);
    return result.rows[0].category;
  }
  audit(tx: Transaction<DB>, input: AuditEventInput) {
    return recordAudit(tx, input);
  }
}
