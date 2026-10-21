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
      changes: Record<string, { from: unknown; to: unknown }>;
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
    return paginatedResult(
      result.rows.map(({ total: _total, ...row }) => row),
      total,
      query,
    );
  }
}
