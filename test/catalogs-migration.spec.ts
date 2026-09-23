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

describe.skipIf(process.env.COMS_RUN_DB_TESTS !== '1')(
  'operational catalogs migration',
  () => {
    const databaseName = `coms_catalogs_test_${randomUUID().replaceAll('-', '')}`;
    const legacyUser = {
      email: 'legacy-user@example.com',
      full_name: 'Legacy User',
      contact_number: 'legacy-user',
      hashed_password: 'existing-password-hash',
    };
    let admin: Pool | undefined;
    let testDb: Kysely<any> | undefined;
    let catalogMigrator: Migrator | undefined;

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

      const baseMigrator = new Migrator({
        db: testDb,
        provider: {
          getMigrations: async () => ({ '20260920174538_auth': initial }),
        },
      });
      expect((await baseMigrator.migrateToLatest()).error).toBeUndefined();
      await testDb
        .insertInto('auth.users')
        .values(legacyUser)
        .executeTakeFirstOrThrow();

      catalogMigrator = new Migrator({
        db: testDb,
        provider: {
          getMigrations: async () => ({
            '20260920174538_auth': initial,
            '20260921120000_auth_token_rotation': rotation,
            '20260922164052_auth_rate_limits': limits,
            '20260923214210_access_control': accessControl,
            '20260924004212_operational_catalogs': catalogs,
          }),
        },
      });
      expect((await catalogMigrator.migrateToLatest()).error).toBeUndefined();
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

    it('creates validated catalogs and rolls back only its own schema', async () => {
      const columns = await sql
        .raw(
          "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('suppliers', 'stock_items', 'products') ORDER BY table_name, ordinal_position",
        )
        .execute(testDb!);

      expect(columns.rows).toEqual([
        { table_name: 'products', column_name: 'id' },
        { table_name: 'products', column_name: 'product_name' },
        { table_name: 'products', column_name: 'description' },
        { table_name: 'products', column_name: 'is_active' },
        { table_name: 'products', column_name: 'created_at' },
        { table_name: 'products', column_name: 'updated_at' },
        { table_name: 'stock_items', column_name: 'id' },
        { table_name: 'stock_items', column_name: 'stock_item_name' },
        { table_name: 'stock_items', column_name: 'category' },
        { table_name: 'stock_items', column_name: 'unit' },
        { table_name: 'stock_items', column_name: 'is_active' },
        { table_name: 'stock_items', column_name: 'created_at' },
        { table_name: 'stock_items', column_name: 'updated_at' },
        { table_name: 'suppliers', column_name: 'id' },
        { table_name: 'suppliers', column_name: 'supplier_name' },
        { table_name: 'suppliers', column_name: 'contact_person' },
        { table_name: 'suppliers', column_name: 'contact_number' },
        { table_name: 'suppliers', column_name: 'email' },
        { table_name: 'suppliers', column_name: 'address' },
        { table_name: 'suppliers', column_name: 'is_active' },
        { table_name: 'suppliers', column_name: 'created_at' },
        { table_name: 'suppliers', column_name: 'updated_at' },
      ]);

      const supplier = await testDb!
        .insertInto('suppliers')
        .values({
          supplier_name: 'Metro Foods',
          contact_person: 'Alex Santos',
          contact_number: '+63 900 123 4567',
          email: 'orders@example.com',
          address: 'Quezon City',
        })
        .returning(['id', 'is_active'])
        .executeTakeFirstOrThrow();
      const stockItem = await testDb!
        .insertInto('stock_items')
        .values({
          stock_item_name: 'Chicken breast',
          category: 'Poultry',
          unit: 'kg',
        })
        .returning(['id', 'is_active'])
        .executeTakeFirstOrThrow();
      const product = await testDb!
        .insertInto('products')
        .values({ product_name: 'Chicken sandwich', description: null })
        .returning(['id', 'is_active'])
        .executeTakeFirstOrThrow();

      for (const entry of [supplier, stockItem, product]) {
        expect(entry.id).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        );
        expect(entry.is_active).toBe(true);
      }

      await expect(
        testDb!
          .insertInto('suppliers')
          .values({ supplier_name: '   ' })
          .execute(),
      ).rejects.toHaveProperty('code', '23514');
      await expect(
        testDb!
          .insertInto('stock_items')
          .values({ stock_item_name: 'Flour', category: 'Baking', unit: ' ' })
          .execute(),
      ).rejects.toHaveProperty('code', '23514');
      await expect(
        testDb!.insertInto('products').values({ product_name: ' ' }).execute(),
      ).rejects.toHaveProperty('code', '23514');

      expect((await catalogMigrator!.migrateDown()).error).toBeUndefined();
      const remainingSchema = await sql
        .raw(
          "SELECT to_regclass('public.suppliers')::text AS suppliers, to_regclass('public.stock_items')::text AS stock_items, to_regclass('public.products')::text AS products, to_regclass('public.branches')::text AS branches, to_regclass('auth.roles')::text AS roles",
        )
        .execute(testDb!);
      expect(remainingSchema.rows[0]).toEqual({
        suppliers: null,
        stock_items: null,
        products: null,
        branches: 'branches',
        roles: 'auth.roles',
      });
      await expect(
        testDb!
          .selectFrom('auth.users')
          .select('email')
          .where('email', '=', legacyUser.email)
          .executeTakeFirstOrThrow(),
      ).resolves.toMatchObject({ email: legacyUser.email });
    });
  },
);
