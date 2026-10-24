import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { parse } from 'dotenv';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Keyed by table name: the schema is "auth" at this migration and "coms_auth"
// after the later schema rename, so snapshots compare rows across both.
const legacyColumns = {
  users: ['created_at', 'updated_at'],
  sessions: ['created_at', 'expires_at', 'revoked_at'],
  token_families: ['created_at', 'expires_at', 'revoked_at'],
  refresh_tokens: ['created_at', 'expires_at', 'consumed_at', 'revoked_at'],
};
const migration = '20261020213119_use_timestamptz_for_auth_times';
const predecessor = '20261020202353_dispatch_receiving_followup';

// Never migrates the source database: a uniquely named disposable database only.
describe
  .skipIf(process.env.COMS_RUN_DB_TESTS !== '1')
  .sequential('timestamptz upgrade', () => {
    const name = `coms_time_test_${randomUUID().replaceAll('-', '')}`;
    let admin: Pool;
    let db: Kysely<any>;
    let migrator: Migrator;

    beforeAll(async () => {
      const url = new URL(
        process.env.COMS_TEST_ADMIN_URL ??
          parse(readFileSync('.env')).DATABASE_URL,
      );
      url.pathname = '/postgres';
      admin = new Pool({ connectionString: url.toString() });
      await admin.query(`CREATE DATABASE "${name}"`);
      url.pathname = `/${name}`;
      db = new Kysely({
        dialect: new PostgresDialect({
          pool: new Pool({
            connectionString: url.toString(),
            max: 1,
            options: '-c timezone=UTC',
          }),
        }),
      });
      migrator = new Migrator({
        db,
        provider: {
          getMigrations: async () =>
            Object.fromEntries(
              await Promise.all(
                readdirSync('src/database/migrations')
                  .filter((file) => file.endsWith('.ts'))
                  .map(async (file) => [
                    file.slice(0, -3),
                    await import('../src/database/migrations/' + file),
                  ]),
              ),
            ),
        },
      });
      expect((await migrator.migrateTo(predecessor)).error).toBeUndefined();
      vi.stubEnv('COMS_LEGACY_TIMESTAMP_TIME_ZONE', 'Asia/Manila');
    }, 30000);

    afterAll(async () => {
      vi.unstubAllEnvs();
      await db?.destroy();
      if (admin) {
        await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
        await admin.end();
      }
    });

    async function snapshot(converted = false, schema = 'auth') {
      const result: Record<string, unknown> = {};
      for (const [table, columns] of Object.entries(legacyColumns)) {
        const normalized = converted
          ? sql`to_jsonb(t) || jsonb_build_object(${sql.join(columns.flatMap((column) => [sql`${column}::text`, sql`${sql.ref(column)} AT TIME ZONE 'Asia/Manila'`]))})`
          : sql`to_jsonb(t)`;
        result[table] = (
          await sql`SELECT ${normalized} AS row FROM ${sql.table(`${schema}.${table}`)} t ORDER BY id`.execute(
            db,
          )
        ).rows;
      }
      return result;
    }

    it('preserves every legacy value, null, default and index through upgrade and rollback independently of session timezone', async () => {
      const userId = randomUUID();
      const familyId = randomUUID();
      await sql`INSERT INTO auth.users (id,email,full_name,contact_number,hashed_password,created_at,updated_at)
      VALUES (${userId}, 'time@example.test', 'Time Test', 'time-test', 'test-only', '2026-10-20 00:30:00.123456', '2026-10-20 08:30:00')`.execute(
        db,
      );
      await sql`INSERT INTO auth.sessions (user_id,token_hash,created_at,expires_at,revoked_at)
      VALUES (${userId}, 'session-test', '2026-10-20 00:30:00.123456', '2026-11-19 00:30:00.123456', NULL)`.execute(
        db,
      );
      await sql`INSERT INTO auth.token_families (id,user_id,created_at,expires_at,revoked_at)
      VALUES (${familyId}, ${userId}, '2026-10-20 00:30:00.123456', '2026-11-19 00:30:00.123456', '2026-10-20 01:00:00')`.execute(
        db,
      );
      await sql`INSERT INTO auth.refresh_tokens (family_id,token_hash,created_at,expires_at,consumed_at,revoked_at)
      VALUES (${familyId}, 'refresh-test', '2026-10-20 00:30:00.123456', '2026-11-19 00:30:00.123456', '2026-10-20 00:45:00', NULL)`.execute(
        db,
      );
      const before = await snapshot();
      const indexes =
        await sql`SELECT indexname,indexdef FROM pg_indexes WHERE schemaname = 'auth' ORDER BY indexname`.execute(
          db,
        );
      const defaults =
        await sql`SELECT table_name,column_name,column_default,is_nullable FROM information_schema.columns WHERE table_schema='auth' ORDER BY table_name,column_name`.execute(
          db,
        );
      vi.stubEnv('COMS_LEGACY_TIMESTAMP_TIME_ZONE', 'Invalid/Zone');
      expect((await migrator.migrateTo(migration)).error).toBeTruthy();
      expect(await snapshot()).toEqual(before);
      vi.stubEnv('COMS_LEGACY_TIMESTAMP_TIME_ZONE', 'Asia/Manila');
      expect((await migrator.migrateTo(migration)).error).toBeUndefined();
      expect(await snapshot(true)).toEqual(before);
      const instant = await sql<{
        instant: string;
      }>`SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') AS instant FROM auth.users WHERE id=${userId}`.execute(
        db,
      );
      expect(instant.rows[0].instant).toBe('2026-10-19 16:30:00.123456');
      expect(
        (
          await sql`SELECT indexname,indexdef FROM pg_indexes WHERE schemaname = 'auth' ORDER BY indexname`.execute(
            db,
          )
        ).rows,
      ).toEqual(indexes.rows);
      expect(
        (
          await sql`SELECT table_name,column_name,column_default,is_nullable FROM information_schema.columns WHERE table_schema='auth' ORDER BY table_name,column_name`.execute(
            db,
          )
        ).rows,
      ).toEqual(defaults.rows);
      await sql`SET TIME ZONE 'America/Los_Angeles'`.execute(db);
      expect((await migrator.migrateDown()).error).toBeUndefined();
      expect(await snapshot()).toEqual(before);
      expect((await migrator.migrateToLatest()).error).toBeUndefined();
      expect(await snapshot(true, 'coms_auth')).toEqual(before);
    }, 30000);

    it('stores equal offset inputs as one instant and retains expiry ordering in different sessions', async () => {
      const user = await db
        .selectFrom('coms_auth.users')
        .select('id')
        .executeTakeFirstOrThrow();
      for (const zone of ['UTC', 'Asia/Manila', 'America/Los_Angeles']) {
        await sql`SELECT set_config('TimeZone', ${zone}, false)`.execute(db);
        const row = await db
          .insertInto('coms_auth.token_families')
          .values({
            user_id: user.id,
            created_at: '2027-01-01T00:30:00+08:00',
            expires_at: new Date('2026-12-31T17:30:00Z'),
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        expect(row.created_at.toISOString()).toBe('2026-12-31T16:30:00.000Z');
        expect(row.expires_at.getTime() - row.created_at.getTime()).toBe(
          3600000,
        );
        const result = await sql<{
          valid: boolean;
        }>`SELECT created_at = '2026-12-31T16:30:00Z'::timestamptz AND expires_at > created_at AS valid FROM coms_auth.token_families WHERE id=${row.id}`.execute(
          db,
        );
        expect(result.rows[0].valid).toBe(true);
      }
    });

    it('leaves no timezone-less datetime columns anywhere in the application schema and preserves date-only fields', async () => {
      const columns = await sql<{
        table_schema: string;
        table_name: string;
        column_name: string;
        data_type: string;
      }>`SELECT table_schema,table_name,column_name,data_type FROM information_schema.columns WHERE table_schema IN ('coms_auth','public')`.execute(
        db,
      );
      expect(
        columns.rows.filter(
          (column) => column.data_type === 'timestamp without time zone',
        ),
      ).toEqual([]);
      for (const [table, names] of Object.entries(legacyColumns)) {
        for (const column of names)
          expect(
            columns.rows.find(
              (row) =>
                row.table_schema === 'coms_auth' &&
                row.table_name === table &&
                row.column_name === column,
            )?.data_type,
          ).toBe('timestamp with time zone');
      }
      expect(
        columns.rows
          .filter((column) => column.data_type === 'date')
          .map((column) => `${column.table_name}.${column.column_name}`)
          .sort(),
      ).toEqual([
        'branches.date_opened',
        'daily_branch_reports.business_date',
        'dispatch_late_counts.delivery_date',
        'dispatch_receipts.delivery_date',
        'receiving_notification_sources.reminder_date',
        'supplier_receipts.received_at',
      ]);
    });
  });
