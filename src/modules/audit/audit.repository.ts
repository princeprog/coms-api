import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { DATABASE } from '../../database/database.module';
import type { DB } from '../../database/db';
import { containsSearchPattern } from '../../common/utils/list-filters';
import {
  paginatedResult,
  paginationOffset,
} from '../../common/utils/pagination';
import type { AuditQueryDto } from './dto/audit-query.dto';

type Changes = Record<string, { from: unknown; to: unknown }>;

// Reference columns stored as IDs, shown by their current name.
const references = {
  category_id: 'category',
  role_id: 'role',
} as const;

@Injectable()
export class AuditRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DB>) {}

  async list(query: AuditQueryDto) {
    const search = query.search ? containsSearchPattern(query.search) : null;
    const result = await sql<{
      id: string;
      occurred_at: Date;
      actor_user_id: string | null;
      actor_name: string | null;
      action: string;
      entity_type: string;
      entity_id: string | null;
      entity_label: string | null;
      branch_id: string | null;
      changes: Changes;
      metadata: Record<string, unknown>;
      total: number;
    }>`
      SELECT id, occurred_at, actor_user_id, actor_name, action, entity_type,
        entity_id, entity_label, branch_id, changes, metadata,
        count(*) OVER ()::int AS total
      FROM audit_events
      WHERE (${query.from ?? null}::date IS NULL
          OR occurred_at >= (${query.from ?? null}::date::timestamp AT TIME ZONE 'Asia/Manila'))
        AND (${query.to ?? null}::date IS NULL
          OR occurred_at < ((${query.to ?? null}::date + 1)::timestamp AT TIME ZONE 'Asia/Manila'))
        AND (${query.entity_type ?? null}::text IS NULL OR entity_type = ${query.entity_type ?? null}::text)
        AND (${search}::text IS NULL OR actor_name ILIKE ${search}::text
          OR entity_label ILIKE ${search}::text OR action ILIKE ${search}::text)
      ORDER BY occurred_at DESC, id DESC
      LIMIT ${query.page_size} OFFSET ${paginationOffset(query)}
    `.execute(this.db);
    const total = result.rows[0]?.total ?? 0;
    const names = await this.referenceNames(result.rows.map((r) => r.changes));
    return paginatedResult(
      result.rows.map(({ total: _total, ...row }) => ({
        ...row,
        changes: this.nameReferences(row.changes, names),
      })),
      total,
      query,
    );
  }

  private async referenceNames(changes: Changes[]) {
    const ids = { category: new Set<string>(), role: new Set<string>() };
    for (const change of changes)
      for (const [field, kind] of Object.entries(references))
        for (const value of [change[field]?.from, change[field]?.to])
          if (typeof value === 'string') ids[kind].add(value);
    const [categories, roles] = await Promise.all([
      ids.category.size
        ? this.db
            .selectFrom('product_categories')
            .select(['id', 'name'])
            .where('id', 'in', [...ids.category])
            .execute()
        : [],
      ids.role.size
        ? this.db
            .selectFrom('auth.roles')
            .select(['id', 'role_name as name'])
            .where('id', 'in', [...ids.role])
            .execute()
        : [],
    ]);
    return new Map(
      [...categories, ...roles].map((row) => [String(row.id), row.name]),
    );
  }

  private nameReferences(changes: Changes, names: Map<string, string>) {
    const named = { ...changes };
    for (const field of Object.keys(references)) {
      const change = named[field];
      if (!change) continue;
      const name = (value: unknown) =>
        typeof value === 'string'
          ? (names.get(value) ?? 'Deleted record')
          : value;
      named[field] = { from: name(change.from), to: name(change.to) };
    }
    return named;
  }
}
