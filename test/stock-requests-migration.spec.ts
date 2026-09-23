import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

type MigrationModule = {
  up(db: Kysely<any>): Promise<void>;
  down(db: Kysely<any>): Promise<void>;
};

const migrationLoaders = import.meta.glob<MigrationModule>(
  '../src/database/migrations/*.ts',
);

describe.skipIf(process.env.COMS_RUN_DB_TESTS !== '1')(
  'stock requests migration',
  () => {
    const databaseName = `coms_stock_requests_test_${randomUUID().replaceAll('-', '')}`;
    const migrationNames = Object.keys(migrationLoaders).map((file) =>
      file.split('/').at(-1)!.replace(/\.ts$/, ''),
    );
    const hasStockRequestsMigration = migrationNames.some((name) =>
      name.endsWith('_stock_requests'),
    );
    let admin: Pool | undefined;
    let testDb: Kysely<any> | undefined;
    let migrator: Migrator | undefined;
    let actorId: string;
    let branchId: string;
    let stockItemId: string;

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

      const migrations = Object.fromEntries(
        await Promise.all(
          Object.entries(migrationLoaders).map(async ([file, load]) => [
            file.split('/').at(-1)!.replace(/\.ts$/, ''),
            await load(),
          ]),
        ),
      );
      migrator = new Migrator({
        db: testDb,
        provider: { getMigrations: async () => migrations },
      });
      const migrated = await migrator.migrateToLatest();
      expect(migrated.error).toBeUndefined();

      const noAccessRole = await testDb
        .selectFrom('auth.roles')
        .select('id')
        .where('code', '=', 'NO_ACCESS')
        .executeTakeFirstOrThrow();
      const actor = await testDb
        .insertInto('auth.users')
        .values({
          email: `stock-request-test-${randomUUID()}@example.com`,
          full_name: 'Stock Request Migration Test User',
          contact_number: 'stock-request-migration-test',
          hashed_password: 'existing-password-hash',
          role_id: noAccessRole.id,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      actorId = actor.id;

      const branch = await testDb
        .insertInto('branches')
        .values({
          code: `SR-${randomUUID().slice(0, 8)}`,
          branch_name: 'Stock Request Test Branch',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      branchId = branch.id;

      const stockItem = await testDb
        .insertInto('stock_items')
        .values({
          stock_item_name: `Stock Request Test Flour ${randomUUID()}`,
          category: 'Baking',
          unit: 'kg',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      stockItemId = stockItem.id;
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

    it('creates request, line, and audit tables with exact decimal quantities and constraints', async () => {
      const columns = await sql
        .raw(
          "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('stock_requests', 'stock_request_items', 'stock_request_events') ORDER BY table_name, ordinal_position",
        )
        .execute(testDb!);

      expect(columns.rows).toEqual([
        { table_name: 'stock_request_events', column_name: 'id' },
        {
          table_name: 'stock_request_events',
          column_name: 'stock_request_id',
        },
        { table_name: 'stock_request_events', column_name: 'event_type' },
        { table_name: 'stock_request_events', column_name: 'actor_user_id' },
        { table_name: 'stock_request_events', column_name: 'created_at' },
        { table_name: 'stock_request_items', column_name: 'id' },
        {
          table_name: 'stock_request_items',
          column_name: 'stock_request_id',
        },
        { table_name: 'stock_request_items', column_name: 'stock_item_id' },
        {
          table_name: 'stock_request_items',
          column_name: 'quantity_requested',
        },
        { table_name: 'stock_request_items', column_name: 'created_at' },
        { table_name: 'stock_requests', column_name: 'id' },
        { table_name: 'stock_requests', column_name: 'branch_id' },
        {
          table_name: 'stock_requests',
          column_name: 'requested_by_user_id',
        },
        { table_name: 'stock_requests', column_name: 'status' },
        { table_name: 'stock_requests', column_name: 'idempotency_key' },
        { table_name: 'stock_requests', column_name: 'created_at' },
        { table_name: 'stock_requests', column_name: 'updated_at' },
      ]);

      const idempotencyKey = randomUUID();
      const stockRequest = await testDb!
        .insertInto('stock_requests')
        .values({
          branch_id: branchId,
          requested_by_user_id: actorId,
          idempotency_key: idempotencyKey,
        })
        .returning(['id', 'status'])
        .executeTakeFirstOrThrow();
      expect(stockRequest.status).toBe('PENDING');

      const item = await testDb!
        .insertInto('stock_request_items')
        .values({
          stock_request_id: stockRequest.id,
          stock_item_id: stockItemId,
          quantity_requested: '12.5000',
        })
        .returning('quantity_requested')
        .executeTakeFirstOrThrow();
      expect(item.quantity_requested).toBe('12.5000');

      await testDb!
        .insertInto('stock_request_events')
        .values({
          stock_request_id: stockRequest.id,
          event_type: 'SUBMITTED',
          actor_user_id: actorId,
        })
        .execute();

      await expect(
        testDb!
          .insertInto('stock_request_items')
          .values({
            stock_request_id: stockRequest.id,
            stock_item_id: stockItemId,
            quantity_requested: '0',
          })
          .execute(),
      ).rejects.toHaveProperty('code', '23514');
      await expect(
        testDb!
          .insertInto('stock_request_items')
          .values({
            stock_request_id: stockRequest.id,
            stock_item_id: stockItemId,
            quantity_requested: '1',
          })
          .execute(),
      ).rejects.toHaveProperty('code', '23505');
      await expect(
        testDb!
          .insertInto('stock_requests')
          .values({
            branch_id: branchId,
            requested_by_user_id: actorId,
            idempotency_key: idempotencyKey,
          })
          .execute(),
      ).rejects.toHaveProperty('code', '23505');
      await expect(
        testDb!
          .updateTable('stock_requests')
          .set({ status: 'DISPATCHED' })
          .where('id', '=', stockRequest.id)
          .execute(),
      ).rejects.toHaveProperty('code', '23514');
    });

    it.skipIf(!hasStockRequestsMigration)(
      'rolls back its request schema without removing existing operations data',
      async () => {
        expect((await migrator!.migrateDown()).error).toBeUndefined();
        const remainingSchema = await sql
          .raw(
            "SELECT to_regclass('public.stock_requests')::text AS stock_requests, to_regclass('public.stock_request_items')::text AS stock_request_items, to_regclass('public.stock_request_events')::text AS stock_request_events, to_regclass('public.inventory_movements')::text AS inventory_movements, to_regclass('public.supplier_receipts')::text AS supplier_receipts, to_regclass('public.branches')::text AS branches",
          )
          .execute(testDb!);
        expect(remainingSchema.rows[0]).toEqual({
          stock_requests: null,
          stock_request_items: null,
          stock_request_events: null,
          inventory_movements: 'inventory_movements',
          supplier_receipts: 'supplier_receipts',
          branches: 'branches',
        });
      },
    );
  },
);
