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
import * as supplierReceipts from '../src/database/migrations/20260924014633_supplier_receipts';
import * as stockRequests from '../src/database/migrations/20260924033004_stock_requests';
import * as dispatchesAndTransit from '../src/database/migrations/20260924042448_dispatches_and_transit';
import * as productRecipesAndBranchProducts from '../src/database/migrations/20260924053530_product_recipes_and_branch_products';

describe.skipIf(process.env.COMS_RUN_DB_TESTS !== '1')(
  'product recipes and branch products migration',
  () => {
    const databaseName = `coms_product_operations_test_${randomUUID().replaceAll('-', '')}`;
    let admin: Pool | undefined;
    let testDb: Kysely<any> | undefined;
    let migrator: Migrator | undefined;
    let productId: string;
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

      migrator = new Migrator({
        db: testDb,
        provider: {
          getMigrations: async () => ({
            '20260920174538_auth': initial,
            '20260921120000_auth_token_rotation': rotation,
            '20260922164052_auth_rate_limits': limits,
            '20260923214210_access_control': accessControl,
            '20260924004212_operational_catalogs': catalogs,
            '20260924012454_inventory_ledger': inventory,
            '20260924014633_supplier_receipts': supplierReceipts,
            '20260924033004_stock_requests': stockRequests,
            '20260924042448_dispatches_and_transit': dispatchesAndTransit,
            '20260924053530_product_recipes_and_branch_products':
              productRecipesAndBranchProducts,
          }),
        },
      });
      expect((await migrator.migrateToLatest()).error).toBeUndefined();

      productId = (
        await testDb
          .insertInto('products')
          .values({ product_name: 'Chicken sandwich' })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      branchId = (
        await testDb
          .insertInto('branches')
          .values({
            code: `PO-${randomUUID().slice(0, 8)}`,
            branch_name: 'Product Operations Test Branch',
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      stockItemId = (
        await testDb
          .insertInto('stock_items')
          .values({
            stock_item_name: `Recipe Test Flour ${randomUUID()}`,
            category: 'Baking',
            unit: 'kg',
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
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

    it('stores exact recipe quantities and branch prices with required constraints', async () => {
      const columns = await sql
        .raw(
          "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('product_ingredients', 'branch_products') ORDER BY table_name, ordinal_position",
        )
        .execute(testDb!);
      expect(columns.rows).toEqual([
        { table_name: 'branch_products', column_name: 'branch_id' },
        { table_name: 'branch_products', column_name: 'product_id' },
        { table_name: 'branch_products', column_name: 'price' },
        { table_name: 'branch_products', column_name: 'is_available' },
        { table_name: 'branch_products', column_name: 'created_at' },
        { table_name: 'branch_products', column_name: 'updated_at' },
        { table_name: 'product_ingredients', column_name: 'product_id' },
        { table_name: 'product_ingredients', column_name: 'stock_item_id' },
        {
          table_name: 'product_ingredients',
          column_name: 'quantity_required',
        },
        { table_name: 'product_ingredients', column_name: 'created_at' },
        { table_name: 'product_ingredients', column_name: 'updated_at' },
      ]);

      const ingredient = await testDb!
        .insertInto('product_ingredients')
        .values({
          product_id: productId,
          stock_item_id: stockItemId,
          quantity_required: '0.0250',
        })
        .returning(['quantity_required', 'created_at'])
        .executeTakeFirstOrThrow();
      expect(ingredient.quantity_required).toBe('0.0250');
      expect(ingredient.created_at).toBeInstanceOf(Date);

      const offering = await testDb!
        .insertInto('branch_products')
        .values({
          branch_id: branchId,
          product_id: productId,
          price: '149.50',
        })
        .returning(['price', 'is_available'])
        .executeTakeFirstOrThrow();
      expect(offering).toEqual({ price: '149.50', is_available: true });

      await expect(
        testDb!
          .insertInto('product_ingredients')
          .values({
            product_id: productId,
            stock_item_id: stockItemId,
            quantity_required: '1',
          })
          .execute(),
      ).rejects.toHaveProperty('code', '23505');
      await expect(
        testDb!
          .insertInto('product_ingredients')
          .values({
            product_id: productId,
            stock_item_id: randomUUID(),
            quantity_required: '0',
          })
          .execute(),
      ).rejects.toHaveProperty('code', '23514');
      await expect(
        testDb!
          .insertInto('branch_products')
          .values({
            branch_id: branchId,
            product_id: productId,
            price: '-1',
          })
          .execute(),
      ).rejects.toHaveProperty('code', '23514');
    });

    it('rolls back only its tables and preserves the existing product catalog', async () => {
      expect((await migrator!.migrateDown()).error).toBeUndefined();
      const schema = await sql
        .raw(
          "SELECT to_regclass('public.product_ingredients')::text AS product_ingredients, to_regclass('public.branch_products')::text AS branch_products, to_regclass('public.products')::text AS products, to_regclass('public.stock_items')::text AS stock_items, to_regclass('public.branches')::text AS branches",
        )
        .execute(testDb!);
      expect(schema.rows[0]).toEqual({
        product_ingredients: null,
        branch_products: null,
        products: 'products',
        stock_items: 'stock_items',
        branches: 'branches',
      });
      await expect(
        testDb!
          .selectFrom('products')
          .select('id')
          .where('id', '=', productId)
          .executeTakeFirstOrThrow(),
      ).resolves.toMatchObject({ id: productId });
    });
  },
);
