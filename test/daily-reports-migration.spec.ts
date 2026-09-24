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
import * as dailyBranchReports from '../src/database/migrations/20260924093005_daily_branch_reports';

describe.skipIf(process.env.COMS_RUN_DB_TESTS !== '1')(
  'daily branch reports migration',
  () => {
    const databaseName = `coms_daily_reports_migration_${randomUUID().replaceAll('-', '')}`;
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
            '20260924093005_daily_branch_reports': dailyBranchReports,
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
            email: `daily-report-migration-${randomUUID()}@example.com`,
            full_name: 'Daily Report Migration Test User',
            contact_number: `DR-${randomUUID().slice(0, 12)}`,
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
            code: `DR-${randomUUID().slice(0, 8)}`,
            branch_name: 'Daily Report Migration Test Branch',
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      stockItemId = (
        await testDb
          .insertInto('stock_items')
          .values({
            stock_item_name: `Daily Report Migration Flour ${randomUUID()}`,
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

    it('stores decimal report snapshots, review history, and one reconciliation movement, then rolls back cleanly', async () => {
      const tables = await sql
        .raw(
          "SELECT to_regclass('public.daily_branch_reports')::text AS reports, to_regclass('public.daily_branch_report_items')::text AS items, to_regclass('public.daily_branch_report_events')::text AS events",
        )
        .execute(testDb!);
      expect(tables.rows[0]).toEqual({
        reports: 'daily_branch_reports',
        items: 'daily_branch_report_items',
        events: 'daily_branch_report_events',
      });

      const report = await testDb!
        .insertInto('daily_branch_reports')
        .values({
          branch_id: branchId,
          business_date: '2026-09-23',
          idempotency_key: randomUUID(),
          created_by_user_id: actorId,
        })
        .returning(['id', 'status'])
        .executeTakeFirstOrThrow();
      expect(report.status).toBe('DRAFT');
      const businessDate = await sql<{ business_date: string }>`
        SELECT business_date::text AS business_date
        FROM daily_branch_reports
        WHERE id = ${report.id}
      `.execute(testDb!);
      expect(businessDate.rows[0]?.business_date).toBe('2026-09-23');

      const reportItem = await testDb!
        .insertInto('daily_branch_report_items')
        .values({
          daily_branch_report_id: report.id,
          stock_item_id: stockItemId,
          opening_quantity: '10.5000',
          receipt_quantity: '2.0000',
          sale_consumption_quantity: '1.2500',
          sale_void_reversal_quantity: '0.2500',
          ledger_adjustment_quantity: '-0.5000',
          ledger_closing_quantity: '11.0000',
          waste_quantity: '0.5000',
          waste_reason: 'Spoiled during service',
          adjustment_quantity: '0.2500',
          adjustment_reason: 'Approved count correction',
          expected_closing_quantity: '10.7500',
          physical_closing_quantity: '11.0000',
          variance_quantity: '0.2500',
        })
        .returning(['id', 'opening_quantity', 'variance_quantity'])
        .executeTakeFirstOrThrow();
      expect(reportItem.opening_quantity).toBe('10.5000');
      expect(reportItem.variance_quantity).toBe('0.2500');

      await testDb!
        .insertInto('daily_branch_report_events')
        .values({
          daily_branch_report_id: report.id,
          event_type: 'CREATED',
          actor_user_id: actorId,
        })
        .execute();
      await testDb!
        .insertInto('inventory_movements')
        .values({
          inventory_scope: 'BRANCH',
          branch_id: branchId,
          stock_item_id: stockItemId,
          movement_type: 'REPORT_ADJUSTMENT',
          quantity_delta: '-0.2500',
          reason: 'Daily report reconciliation',
          actor_user_id: actorId,
          daily_branch_report_item_id: reportItem.id,
        })
        .execute();
      await expect(
        testDb!
          .insertInto('inventory_movements')
          .values({
            inventory_scope: 'BRANCH',
            branch_id: branchId,
            stock_item_id: stockItemId,
            movement_type: 'REPORT_ADJUSTMENT',
            quantity_delta: '0.2500',
            reason: 'Duplicate reconciliation',
            actor_user_id: actorId,
            daily_branch_report_item_id: reportItem.id,
          })
          .execute(),
      ).rejects.toHaveProperty('code', '23505');

      await expect(
        testDb!
          .insertInto('daily_branch_report_items')
          .values({
            daily_branch_report_id: report.id,
            stock_item_id: stockItemId,
            opening_quantity: '0',
            receipt_quantity: '0',
            sale_consumption_quantity: '0',
            sale_void_reversal_quantity: '0',
            ledger_adjustment_quantity: '0',
            ledger_closing_quantity: '0',
            expected_closing_quantity: '0',
          })
          .execute(),
      ).rejects.toHaveProperty('code', '23505');

      expect((await migrator!.migrateDown()).error).toBeUndefined();
      const remainingSchema = await sql
        .raw(
          "SELECT to_regclass('public.daily_branch_reports')::text AS reports, to_regclass('public.daily_branch_report_items')::text AS items, to_regclass('public.daily_branch_report_events')::text AS events, to_regclass('public.inventory_movements')::text AS inventory_movements, to_regclass('public.sales')::text AS sales, to_regclass('public.branches')::text AS branches",
        )
        .execute(testDb!);
      expect(remainingSchema.rows[0]).toEqual({
        reports: null,
        items: null,
        events: null,
        inventory_movements: 'inventory_movements',
        sales: 'sales',
        branches: 'branches',
      });
      const movementColumns = await sql<{ column_name: string }>`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'inventory_movements'
      `.execute(testDb!);
      expect(movementColumns.rows.map((row) => row.column_name)).not.toContain(
        'daily_branch_report_item_id',
      );
      await expect(
        testDb!
          .selectFrom('auth.users')
          .select('id')
          .where('id', '=', actorId)
          .executeTakeFirstOrThrow(),
      ).resolves.toMatchObject({ id: actorId });
    });
  },
);
