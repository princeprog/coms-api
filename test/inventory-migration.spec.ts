import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as initial from '../src/database/migrations/20260920174538_auth';
import * as rotation from '../src/database/migrations/20260921120000_auth_token_rotation';
import * as limits from '../src/database/migrations/20260922164052_auth_rate_limits';
import * as accessControl from '../src/database/migrations/20260923214210_access_control';
import * as catalogs from '../src/database/migrations/20260924004212_operational_catalogs';
import * as inventory from '../src/database/migrations/20260924012454_inventory_ledger';

describe.skipIf(process.env.COMS_RUN_DB_TESTS !== '1')(
  'inventory ledger migration',
  () => {
    const databaseName = `coms_inventory_test_${randomUUID().replaceAll('-', '')}`;
    const legacyUser = {
      email: 'inventory-test@example.com',
      full_name: 'Inventory Test User',
      contact_number: 'inventory-test',
      hashed_password: 'existing-password-hash',
    };
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

      const migrationProvider = {
        getMigrations: async () => ({
          '20260920174538_auth': initial,
          '20260921120000_auth_token_rotation': rotation,
          '20260922164052_auth_rate_limits': limits,
          '20260923214210_access_control': accessControl,
          '20260924004212_operational_catalogs': catalogs,
          '20260924012454_inventory_ledger': inventory,
        }),
      };
      const baseline = new Migrator({
        db: testDb,
        provider: {
          getMigrations: async () => ({ '20260920174538_auth': initial }),
        },
      });
      expect((await baseline.migrateToLatest()).error).toBeUndefined();
      const actor = await testDb
        .insertInto('auth.users')
        .values(legacyUser)
        .returning('id')
        .executeTakeFirstOrThrow();
      actorId = actor.id;

      migrator = new Migrator({ db: testDb, provider: migrationProvider });
      expect((await migrator.migrateToLatest()).error).toBeUndefined();
      const branch = await testDb
        .insertInto('branches')
        .values({ code: 'INV-TEST', branch_name: 'Inventory Test Branch' })
        .returning('id')
        .executeTakeFirstOrThrow();
      branchId = branch.id;
      const stockItem = await testDb
        .insertInto('stock_items')
        .values({
          stock_item_name: 'Inventory Test Flour',
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

    it('creates nonnegative balances and a validated, idempotent movement ledger', async () => {
      const commissaryBalance = await testDb!
        .insertInto('commissary_inventory')
        .values({ stock_item_id: stockItemId })
        .returning('quantity_on_hand')
        .executeTakeFirstOrThrow();
      expect(String(commissaryBalance.quantity_on_hand)).toBe('0');

      const branchBalance = await testDb!
        .insertInto('branch_inventory')
        .values({ branch_id: branchId, stock_item_id: stockItemId })
        .returning('quantity_on_hand')
        .executeTakeFirstOrThrow();
      expect(String(branchBalance.quantity_on_hand)).toBe('0');

      const idempotencyKey = randomUUID();
      const movement = await testDb!
        .insertInto('inventory_movements')
        .values({
          inventory_scope: 'COMMISSARY',
          stock_item_id: stockItemId,
          branch_id: null,
          movement_type: 'ADJUSTMENT',
          quantity_delta: '2.5',
          reason: 'Physical count correction',
          actor_user_id: actorId,
          idempotency_key: idempotencyKey,
        })
        .returning(['id', 'quantity_delta', 'reason'])
        .executeTakeFirstOrThrow();
      expect(movement.quantity_delta).toBe('2.5');
      expect(movement.reason).toBe('Physical count correction');

      await expect(
        testDb!
          .insertInto('commissary_inventory')
          .values({ stock_item_id: stockItemId, quantity_on_hand: '-1' })
          .execute(),
      ).rejects.toHaveProperty('code', '23514');
      await expect(
        testDb!
          .insertInto('inventory_movements')
          .values({
            inventory_scope: 'COMMISSARY',
            stock_item_id: stockItemId,
            movement_type: 'ADJUSTMENT',
            quantity_delta: '1',
            reason: '   ',
            actor_user_id: actorId,
          })
          .execute(),
      ).rejects.toHaveProperty('code', '23514');
      await expect(
        testDb!
          .insertInto('inventory_movements')
          .values({
            inventory_scope: 'COMMISSARY',
            stock_item_id: stockItemId,
            movement_type: 'ADJUSTMENT',
            quantity_delta: '1',
            reason: null,
            actor_user_id: actorId,
          })
          .execute(),
      ).rejects.toHaveProperty('code', '23514');
      await expect(
        testDb!
          .insertInto('inventory_movements')
          .values({
            inventory_scope: 'COMMISSARY',
            stock_item_id: stockItemId,
            movement_type: 'ADJUSTMENT',
            quantity_delta: '0',
            reason: 'No quantity change',
            actor_user_id: actorId,
          })
          .execute(),
      ).rejects.toHaveProperty('code', '23514');
      await expect(
        testDb!
          .insertInto('inventory_movements')
          .values({
            inventory_scope: 'BRANCH',
            stock_item_id: stockItemId,
            branch_id: null,
            movement_type: 'SALE',
            quantity_delta: '-1',
            actor_user_id: actorId,
          })
          .execute(),
      ).rejects.toHaveProperty('code', '23514');
      await expect(
        testDb!
          .insertInto('inventory_movements')
          .values({
            inventory_scope: 'COMMISSARY',
            stock_item_id: stockItemId,
            movement_type: 'ADJUSTMENT',
            quantity_delta: '1',
            reason: 'Duplicate request',
            actor_user_id: actorId,
            idempotency_key: idempotencyKey,
          })
          .execute(),
      ).rejects.toHaveProperty('code', '23505');

      expect((await migrator!.migrateDown()).error).toBeUndefined();
      const remainingSchema = await sql
        .raw(
          "SELECT to_regclass('public.commissary_inventory')::text AS commissary_inventory, to_regclass('public.branch_inventory')::text AS branch_inventory, to_regclass('public.inventory_movements')::text AS inventory_movements, to_regclass('public.stock_items')::text AS stock_items, to_regclass('public.branches')::text AS branches, to_regclass('auth.users')::text AS users",
        )
        .execute(testDb!);
      expect(remainingSchema.rows[0]).toEqual({
        commissary_inventory: null,
        branch_inventory: null,
        inventory_movements: null,
        stock_items: 'stock_items',
        branches: 'branches',
        users: 'auth.users',
      });
      await expect(
        testDb!
          .selectFrom('auth.users')
          .select('email')
          .where('id', '=', actorId)
          .executeTakeFirstOrThrow(),
      ).resolves.toMatchObject({ email: legacyUser.email });
    });
  },
);
