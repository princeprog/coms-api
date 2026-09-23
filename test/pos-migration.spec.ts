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
import * as posSales from '../src/database/migrations/20260924064827_pos_sales';

describe.skipIf(process.env.COMS_RUN_DB_TESTS !== '1')(
  'POS sales migration',
  () => {
    const databaseName = `coms_pos_migration_${randomUUID().replaceAll('-', '')}`;
    let admin: Pool | undefined;
    let testDb: Kysely<any> | undefined;
    let migrator: Migrator | undefined;
    let actorId: string;
    let branchId: string;
    let productId: string;
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
            '20260924064827_pos_sales': posSales,
          }),
        },
      });
      expect((await migrator.migrateToLatest()).error).toBeUndefined();

      const noAccess = await testDb
        .selectFrom('auth.roles')
        .select('id')
        .where('code', '=', 'NO_ACCESS')
        .executeTakeFirstOrThrow();
      actorId = (
        await testDb
          .insertInto('auth.users')
          .values({
            email: `pos-migration-${randomUUID()}@example.com`,
            full_name: 'POS Migration Test User',
            contact_number: `PM-${randomUUID().slice(0, 12)}`,
            hashed_password: 'test-only-hash',
            role_id: noAccess.id,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      branchId = (
        await testDb
          .insertInto('branches')
          .values({
            code: `PM-${randomUUID().slice(0, 8)}`,
            branch_name: 'POS Migration Test Branch',
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      productId = (
        await testDb
          .insertInto('products')
          .values({ product_name: `POS Migration Product ${randomUUID()}` })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      stockItemId = (
        await testDb
          .insertInto('stock_items')
          .values({
            stock_item_name: `POS Migration Flour ${randomUUID()}`,
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

    it('stores exact sale and recipe-consumption snapshots with one void reversal', async () => {
      const schema = await sql
        .raw(
          "SELECT to_regclass('public.sales')::text AS sales, to_regclass('public.sale_items')::text AS sale_items, to_regclass('public.sale_item_consumptions')::text AS sale_item_consumptions, to_regclass('public.sale_events')::text AS sale_events",
        )
        .execute(testDb!);
      expect(schema.rows[0]).toEqual({
        sales: 'sales',
        sale_items: 'sale_items',
        sale_item_consumptions: 'sale_item_consumptions',
        sale_events: 'sale_events',
      });

      const saleKey = randomUUID();
      const sale = await testDb!
        .insertInto('sales')
        .values({
          branch_id: branchId,
          cashier_user_id: actorId,
          status: 'COMPLETED',
          tender_method: 'cash',
          total_amount: '3.2500',
          idempotency_key: saleKey,
        })
        .returning(['id', 'total_amount'])
        .executeTakeFirstOrThrow();
      expect(sale.total_amount).toBe('3.2500');

      const line = await testDb!
        .insertInto('sale_items')
        .values({
          sale_id: sale.id,
          product_id: productId,
          product_name_snapshot: 'POS Migration Product',
          quantity: '0.5000',
          unit_price: '6.5000',
          line_total: '3.2500',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const consumption = await testDb!
        .insertInto('sale_item_consumptions')
        .values({
          sale_item_id: line.id,
          stock_item_id: stockItemId,
          quantity_consumed: '0.0375',
        })
        .returning(['id', 'quantity_consumed'])
        .executeTakeFirstOrThrow();
      expect(consumption.quantity_consumed).toBe('0.0375');

      await testDb!
        .insertInto('sale_events')
        .values({
          sale_id: sale.id,
          event_type: 'COMPLETED',
          actor_user_id: actorId,
        })
        .execute();
      const originalMovement = await testDb!
        .insertInto('inventory_movements')
        .values({
          inventory_scope: 'BRANCH',
          branch_id: branchId,
          stock_item_id: stockItemId,
          movement_type: 'SALE',
          quantity_delta: '-0.0375',
          actor_user_id: actorId,
          sale_item_consumption_id: consumption.id,
        })
        .returning(['id', 'quantity_delta'])
        .executeTakeFirstOrThrow();
      expect(originalMovement.quantity_delta).toBe('-0.0375');

      const voidKey = randomUUID();
      await testDb!
        .updateTable('sales')
        .set({ status: 'VOIDED' })
        .where('id', '=', sale.id)
        .executeTakeFirstOrThrow();
      await testDb!
        .insertInto('sale_events')
        .values({
          sale_id: sale.id,
          event_type: 'VOIDED',
          actor_user_id: actorId,
          reason: 'Wrong order',
          idempotency_key: voidKey,
        })
        .execute();
      const reversal = await testDb!
        .insertInto('inventory_movements')
        .values({
          inventory_scope: 'BRANCH',
          branch_id: branchId,
          stock_item_id: stockItemId,
          movement_type: 'SALE_VOID',
          quantity_delta: '0.0375',
          reason: 'Wrong order',
          actor_user_id: actorId,
          reversal_of_movement_id: originalMovement.id,
        })
        .returning('quantity_delta')
        .executeTakeFirstOrThrow();
      expect(reversal.quantity_delta).toBe('0.0375');

      await expect(
        testDb!
          .insertInto('inventory_movements')
          .values({
            inventory_scope: 'BRANCH',
            branch_id: branchId,
            stock_item_id: stockItemId,
            movement_type: 'SALE_VOID',
            quantity_delta: '0.0375',
            reason: 'Duplicate reversal',
            actor_user_id: actorId,
            reversal_of_movement_id: originalMovement.id,
          })
          .execute(),
      ).rejects.toHaveProperty('code', '23505');

      expect((await migrator!.migrateDown()).error).toBeUndefined();
      const remainingSchema = await sql
        .raw(
          "SELECT to_regclass('public.sales')::text AS sales, to_regclass('public.sale_items')::text AS sale_items, to_regclass('public.sale_item_consumptions')::text AS sale_item_consumptions, to_regclass('public.sale_events')::text AS sale_events, to_regclass('public.inventory_movements')::text AS inventory_movements, to_regclass('public.products')::text AS products",
        )
        .execute(testDb!);
      expect(remainingSchema.rows[0]).toEqual({
        sales: null,
        sale_items: null,
        sale_item_consumptions: null,
        sale_events: null,
        inventory_movements: 'inventory_movements',
        products: 'products',
      });
      const movementColumns = await sql<{ column_name: string }>`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'inventory_movements'
      `.execute(testDb!);
      expect(movementColumns.rows.map((row) => row.column_name)).not.toContain(
        'sale_item_consumption_id',
      );
      expect(movementColumns.rows.map((row) => row.column_name)).not.toContain(
        'reversal_of_movement_id',
      );
      await expect(
        testDb!
          .selectFrom('auth.users')
          .select('id')
          .where('id', '=', actorId)
          .executeTakeFirstOrThrow(),
      ).resolves.toMatchObject({ id: actorId });
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
