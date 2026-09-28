import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as migration from '../src/database/migrations/20260928224337_dispatch_discrepancies';

describe.skipIf(process.env.COMS_RUN_DB_TESTS !== '1')(
  'dispatch discrepancy migration',
  () => {
    const databaseName = `coms_discrepancy_migration_${randomUUID().replaceAll('-', '')}`;
    let admin: Pool | undefined;
    let testDb: Kysely<any> | undefined;
    const dispatchId = randomUUID();
    const actorId = randomUUID();

    beforeAll(async () => {
      const source =
        process.env.COMS_TEST_ADMIN_URL ??
        parse(readFileSync('.env')).DATABASE_URL;
      const url = new URL(source);
      admin = new Pool({ connectionString: url.toString() });
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      url.pathname = `/${databaseName}`;
      testDb = new Kysely({
        dialect: new PostgresDialect({
          pool: new Pool({ connectionString: url.toString() }),
        }),
      });

      await sql`CREATE SCHEMA auth`.execute(testDb);
      await sql`CREATE TABLE auth.users (id uuid PRIMARY KEY)`.execute(testDb);
      await sql`CREATE TABLE dispatches (id uuid PRIMARY KEY)`.execute(testDb);
      await migration.up(testDb);
    }, 30000);

    afterAll(async () => {
      if (testDb) await testDb.destroy();
      if (admin) {
        await admin.query(
          `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`,
        );
        await admin.end();
      }
    });

    it('creates the discrepancy and append-only event tables', async () => {
      const result = await sql<{
        discrepancies: string | null;
        events: string | null;
      }>`
        SELECT to_regclass('public.dispatch_discrepancies')::text AS discrepancies,
               to_regclass('public.dispatch_discrepancy_events')::text AS events
      `.execute(testDb!);

      expect(result.rows[0]).toEqual({
        discrepancies: 'dispatch_discrepancies',
        events: 'dispatch_discrepancy_events',
      });
    });

    it('refuses to roll back while discrepancy history exists, then removes an empty schema', async () => {
      await sql`INSERT INTO auth.users (id) VALUES (${actorId})`.execute(testDb!);
      await sql`INSERT INTO dispatches (id) VALUES (${dispatchId})`.execute(
        testDb!,
      );
      const discrepancyId = randomUUID();
      await sql`
        INSERT INTO dispatch_discrepancies
          (id, dispatch_id, status, reported_by_user_id, idempotency_key)
        VALUES
          (${discrepancyId}, ${dispatchId}, 'OPEN', ${actorId}, ${randomUUID()})
      `.execute(testDb!);
      await sql`
        INSERT INTO dispatch_discrepancy_events
          (discrepancy_id, event_type, actor_user_id, note, idempotency_key)
        VALUES
          (${discrepancyId}, 'REPORTED', ${actorId}, 'Short receipt', ${randomUUID()})
      `.execute(testDb!);

      await expect(migration.down(testDb!)).rejects.toThrow(
        'Cannot roll back dispatch discrepancies while discrepancy records or their audit history exist.',
      );
      const history = await sql<{ count: number }>`
        SELECT count(*)::int AS count FROM dispatch_discrepancy_events
        WHERE discrepancy_id = ${discrepancyId}
      `.execute(testDb!);
      expect(history.rows[0]?.count).toBe(1);

      await sql`
        DELETE FROM dispatch_discrepancy_events WHERE discrepancy_id = ${discrepancyId}
      `.execute(testDb!);
      await sql`
        DELETE FROM dispatch_discrepancies WHERE id = ${discrepancyId}
      `.execute(testDb!);
      await migration.down(testDb!);
      const removed = await sql<{ discrepancies: string | null }>`
        SELECT to_regclass('public.dispatch_discrepancies')::text AS discrepancies
      `.execute(testDb!);
      expect(removed.rows[0]?.discrepancies).toBeNull();
    });
  },
);
