import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { DATABASE } from '../../database/database.module';
import type { DB } from '../../database/db';
import { containsSearchPattern } from '../../common/utils/list-filters';
import type { ExpenseQueryDto } from './dto/expense.dto';
import type {
  ExpenseAccess,
  ExpenseDetail,
  ExpenseExecutor,
  ExpensePage,
  ExpenseSource,
} from './expense.types';

export type ExpenseFilters = ExpenseQueryDto & { from: string; to: string };

function visibleSnapshot(
  column: 'before_values' | 'after_values',
  access: ExpenseAccess,
) {
  const snapshot = sql.ref(`h.${column}`);
  return sql`(${snapshot} IS NULL OR (
    (${snapshot}->>'scope' = 'COMMISSARY' AND ${access.commissary}) OR
    (${snapshot}->>'scope' = 'BRANCH' AND (${access.branchIds === null} OR
      (${snapshot}->>'branch_id')::uuid = ANY(${access.branchIds ?? []}::uuid[])))
  ))`;
}

// Money remains PostgreSQL numeric until the final text projection. Receipt lines
// are aggregated before unioning, so each source receipt contributes exactly once.
function sources(access: ExpenseAccess) {
  return sql`
    SELECT e.id, 'OPERATING'::text AS source, e.expense_date,
      e.inventory_scope AS scope, e.branch_id,
      CASE WHEN e.inventory_scope = 'COMMISSARY' THEN 'Commissary' ELSE b.branch_name END AS location_name,
      e.category_id::text, c.name AS category_name, e.description, e.amount,
      e.payment_method, e.cash_source, e.cash_movement_id, e.payee, e.reference, e.notes,
      e.status, e.revision, e.created_by_user_id, u.full_name AS created_by_name,
      e.created_at, e.updated_at
    FROM expenses e
    JOIN expense_categories c ON c.id = e.category_id
    JOIN coms_auth.users u ON u.id = e.created_by_user_id
    LEFT JOIN branches b ON b.id = e.branch_id
    WHERE (e.inventory_scope = 'COMMISSARY' AND ${access.commissary})
      OR (e.inventory_scope = 'BRANCH' AND
        (${access.branchIds === null} OR e.branch_id = ANY(${access.branchIds ?? []}::uuid[])))
    UNION ALL
    SELECT sr.id, sr.receipt_kind, (sr.received_at AT TIME ZONE 'Asia/Manila')::date,
      'COMMISSARY', NULL::uuid, 'Commissary', 'STOCK_PURCHASES', 'Stock purchases',
      CASE WHEN sr.receipt_kind = 'DIRECT_PURCHASE'
        THEN 'Direct purchase' ELSE 'Supplier delivery' END ||
        coalesce(' — ' || coalesce(s.supplier_name, sr.store_name), ''),
      coalesce(lines.amount, 0), NULL::text, NULL::text, NULL::uuid,
      NULL::text, NULL::text, NULL::text, 'RECORDED', 1,
      sr.recorded_by_user_id, u.full_name, sr.created_at, sr.updated_at
    FROM supplier_receipts sr
    JOIN coms_auth.users u ON u.id = sr.recorded_by_user_id
    LEFT JOIN suppliers s ON s.id = sr.supplier_id
    LEFT JOIN LATERAL (
      SELECT sum(sri.quantity_received * sri.unit_cost) AS amount
      FROM supplier_receipt_items sri WHERE sri.supplier_receipt_id = sr.id
    ) lines ON true
    WHERE ${access.commissary} AND sr.receipt_kind IN ('SUPPLIER_DELIVERY', 'DIRECT_PURCHASE')
  `;
}

@Injectable()
export class ExpensesReadRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DB>) {}

  async list(
    query: ExpenseFilters,
    access: ExpenseAccess,
  ): Promise<ExpensePage> {
    const search = query.search ? containsSearchPattern(query.search) : null;
    const order = {
      newest: sql`expense_date DESC, created_at DESC, source, id`,
      oldest: sql`expense_date ASC, created_at ASC, source, id`,
      amount_highest: sql`amount DESC, expense_date DESC, source, id`,
      amount_lowest: sql`amount ASC, expense_date DESC, source, id`,
    }[query.sort ?? 'newest'];
    const result = await sql<ExpensePage>`
      WITH source_rows AS (${sources(access)}), filtered AS MATERIALIZED (
        SELECT * FROM source_rows r
        WHERE expense_date BETWEEN ${query.from}::date AND ${query.to}::date
          AND (${query.scope ?? null}::text IS NULL OR scope = ${query.scope ?? null})
          AND (${query.branch_id ?? null}::uuid IS NULL OR branch_id = ${query.branch_id ?? null}::uuid)
          AND (${query.category_id ?? null}::text IS NULL OR category_id = ${query.category_id ?? null})
          AND (${query.source ?? null}::text IS NULL OR source = ${query.source ?? null})
          AND (${query.status ?? 'RECORDED'} = 'all' OR status = ${query.status ?? 'RECORDED'})
          AND (${search}::text IS NULL OR concat_ws(' ', description, payee, reference, notes,
            location_name, category_name, created_by_name) ILIKE ${search}::text)
      ), page_rows AS (
        SELECT * FROM filtered ORDER BY ${order}
        LIMIT ${query.page_size} OFFSET ${(query.page - 1) * query.page_size}
      ), recorded AS (SELECT * FROM filtered WHERE status = 'RECORDED'),
      locations AS (
        SELECT coalesce(branch_id::text, 'COMMISSARY') AS id, location_name AS name, sum(amount) AS amount
        FROM recorded GROUP BY branch_id, location_name
      ), categories AS (
        SELECT category_id AS id, category_name AS name, sum(amount) AS amount
        FROM recorded GROUP BY category_id, category_name
      )
      SELECT
        coalesce((SELECT jsonb_agg(to_jsonb(p) || jsonb_build_object('amount', p.amount::text) ORDER BY ${order}) FROM page_rows p), '[]'::jsonb) AS items,
        (SELECT count(*)::int FROM filtered) AS total,
        ${query.page}::int AS page, ${query.page_size}::int AS page_size,
        (SELECT jsonb_build_object(
          'recorded_spending', coalesce(sum(amount), 0)::text,
          'operating_expenses', coalesce(sum(amount) FILTER (WHERE source = 'OPERATING'), 0)::text,
          'stock_purchases', coalesce(sum(amount) FILTER (WHERE source <> 'OPERATING'), 0)::text
        ) FROM recorded) AS summary,
        coalesce((SELECT jsonb_agg(jsonb_build_object('id', id, 'name', name, 'amount', amount::text) ORDER BY amount DESC, name, id) FROM locations), '[]'::jsonb) AS by_location,
        coalesce((SELECT jsonb_agg(jsonb_build_object('id', id, 'name', name, 'amount', amount::text) ORDER BY amount DESC, name, id) FROM categories), '[]'::jsonb) AS by_category
    `.execute(this.db);
    return result.rows[0];
  }

  async detail(
    source: ExpenseSource,
    id: string,
    access: ExpenseAccess,
    executor: ExpenseExecutor = this.db,
  ) {
    const result = await sql<Pick<ExpenseDetail, 'record' | 'history'>>`
      WITH source_rows AS (${sources(access)})
      SELECT to_jsonb(r) || jsonb_build_object('amount', r.amount::text) AS record,
        CASE WHEN r.source = 'OPERATING' THEN coalesce((
          SELECT jsonb_agg(jsonb_build_object('id', h.id, 'action', h.action,
            'reason', h.reason, 'actor_name', u.full_name, 'created_at', h.created_at,
            'before', h.before_values, 'after', h.after_values)
            ORDER BY (h.after_values->>'revision')::int, h.created_at, h.id)
          FROM expense_events h JOIN coms_auth.users u ON u.id = h.actor_user_id
          WHERE h.expense_id = r.id
            AND ${visibleSnapshot('before_values', access)}
            AND ${visibleSnapshot('after_values', access)}
        ), '[]'::jsonb) ELSE '[]'::jsonb END AS history
      FROM source_rows r WHERE r.id = ${id}::uuid AND r.source = ${source}
    `.execute(executor);
    return result.rows[0];
  }
}
