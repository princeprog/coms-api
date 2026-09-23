import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import { DATABASE } from '../../database/database.module';
import type { DB } from '../../database/db';

export type RateDecision = { allowed: boolean; retryAfterSeconds: number };

@Injectable()
export class AuthRateLimitRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DB>) {}

  async consume(
    scope: 'login' | 'refresh' | 'capacity',
    identifier: string,
    limit: number,
    db: Kysely<DB> | Transaction<DB> = this.db,
    successesOnly = false,
  ): Promise<RateDecision> {
    const key = createHash('sha256').update(identifier).digest('hex');
    const result = await sql<{ count: number; retry_after: number }>`
      INSERT INTO auth.rate_limit_buckets AS bucket (scope, key_hash, count, reset_at)
      VALUES (${scope}, ${key}, 1, clock_timestamp() + interval '1 minute')
      ON CONFLICT (scope, key_hash) DO UPDATE SET
        count = CASE WHEN bucket.reset_at <= clock_timestamp() THEN 1 ELSE least(bucket.count + 1, ${limit + 1}) END,
        reset_at = CASE WHEN bucket.reset_at <= clock_timestamp() THEN clock_timestamp() + interval '1 minute' ELSE bucket.reset_at END
      ${successesOnly ? sql`WHERE bucket.count < ${limit} OR bucket.reset_at <= clock_timestamp()` : sql``}
      RETURNING count, greatest(1, ceil(extract(epoch FROM reset_at - clock_timestamp())))::integer AS retry_after
    `.execute(db);
    const row = result.rows[0];
    if (row)
      return {
        allowed: row.count <= limit,
        retryAfterSeconds: row.retry_after,
      };
    const retry = await sql<{ retry_after: number }>`
      SELECT greatest(1, ceil(extract(epoch FROM reset_at - clock_timestamp())))::integer AS retry_after
      FROM auth.rate_limit_buckets WHERE scope = ${scope} AND key_hash = ${key}
    `.execute(db);
    return {
      allowed: false,
      retryAfterSeconds: retry.rows[0]?.retry_after ?? 1,
    };
  }

  async cleanup(): Promise<void> {
    await sql`DELETE FROM auth.rate_limit_buckets WHERE ctid IN (
      SELECT ctid FROM auth.rate_limit_buckets WHERE reset_at < clock_timestamp() - interval '1 minute'
      ORDER BY reset_at LIMIT 100 FOR UPDATE SKIP LOCKED
    )`.execute(this.db);
  }
}
