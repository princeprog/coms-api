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
import * as dispatches from '../src/database/migrations/20260924042448_dispatches_and_transit';
import * as productOps from '../src/database/migrations/20260924053530_product_recipes_and_branch_products';
import * as pos from '../src/database/migrations/20260924064827_pos_sales';
import * as dailyReports from '../src/database/migrations/20260924093005_daily_branch_reports';
import * as predefinedRoles from '../src/database/migrations/20260926011909_predefined_roles';
import * as noAccess from '../src/database/migrations/20260926032413_remove_no_access_role';
import * as inventoryScopes from '../src/database/migrations/20260927201942_inventory_location_permissions';
import * as roleOperations from '../src/database/migrations/20260928223738_role_scoped_operation_permissions';
import * as discrepancies from '../src/database/migrations/20260928224337_dispatch_discrepancies';
import * as dailySales from '../src/database/migrations/20260928225746_daily_report_sales_summary';
import * as supplierFinal from '../src/database/migrations/20260929100000_supplier_receipts_final_on_create';
import * as directDispatch from '../src/database/migrations/20260929101000_direct_dispatch_and_retire_stock_requests';
import { PERMISSION_CATALOG } from '../src/modules/access-control/permission-catalog';

const oldMigrations = {
  '20260920174538_auth': initial,
  '20260921120000_auth_token_rotation': rotation,
  '20260922164052_auth_rate_limits': limits,
  '20260923214210_access_control': accessControl,
  '20260924004212_operational_catalogs': catalogs,
  '20260924012454_inventory_ledger': inventory,
  '20260924014633_supplier_receipts': supplierReceipts,
  '20260924033004_stock_requests': stockRequests,
  '20260924042448_dispatches_and_transit': dispatches,
  '20260924053530_product_recipes_and_branch_products': productOps,
  '20260924064827_pos_sales': pos,
  '20260924093005_daily_branch_reports': dailyReports,
  '20260926011909_predefined_roles': predefinedRoles,
  '20260926032413_remove_no_access_role': noAccess,
  '20260927201942_inventory_location_permissions': inventoryScopes,
  '20260928223738_role_scoped_operation_permissions': roleOperations,
  '20260928224337_dispatch_discrepancies': discrepancies,
  '20260928225746_daily_report_sales_summary': dailySales,
};

describe.skipIf(process.env.COMS_RUN_DB_TESTS !== '1')(
  'direct supplier receiving and dispatch migrations',
  () => {
    const databaseName = `coms_direct_workflows_${randomUUID().replaceAll('-', '')}`;
    let admin: Pool | undefined;
    let db: Kysely<any> | undefined;
    let actorId: string;
    let supplierId: string;
    let branchId: string;
    let stockItemId: string;
    let receiptId: string;
    let requestId: string;
    let requestItemId: string;
    let dispatchId: string;

    beforeAll(async () => {
      const source =
        process.env.COMS_TEST_ADMIN_URL ??
        parse(readFileSync('.env')).DATABASE_URL;
      const url = new URL(source);
      admin = new Pool({ connectionString: url.toString() });
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      url.pathname = `/${databaseName}`;
      db = new Kysely({
        dialect: new PostgresDialect({
          pool: new Pool({ connectionString: url.toString() }),
        }),
      });
      const migrator = new Migrator({
        db,
        provider: { getMigrations: async () => oldMigrations },
      });
      expect((await migrator.migrateToLatest()).error).toBeUndefined();

      actorId = (
        await db
          .insertInto('auth.users')
          .values({
            email: `direct-workflows-${randomUUID()}@example.com`,
            full_name: 'Direct Workflows Test',
            contact_number: randomUUID().slice(0, 14),
            hashed_password: 'test-hash',
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      supplierId = (
        await db
          .insertInto('suppliers')
          .values({ supplier_name: `Workflow Supplier ${randomUUID()}` })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      branchId = (
        await db
          .insertInto('branches')
          .values({
            code: `DW-${randomUUID().slice(0, 8)}`,
            branch_name: 'Direct Workflow Branch',
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      stockItemId = (
        await db
          .insertInto('stock_items')
          .values({
            stock_item_name: `Workflow Item ${randomUUID()}`,
            category: 'Baking',
            unit: 'kg',
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    }, 30000);

    afterAll(async () => {
      if (db) await db.destroy();
      if (admin) {
        await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
        await admin.end();
      }
    });

    it('guards draft receipts, preserves recording audit, and restores only original grants on rollback', async () => {
      const receipt = await db!
        .insertInto('supplier_receipts')
        .values({
          supplier_id: supplierId,
          received_at: '2026-09-20',
          idempotency_key: randomUUID(),
          created_by_user_id: actorId,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      receiptId = receipt.id;
      const manager = await db!
        .selectFrom('auth.roles')
        .select('id')
        .where('code', '=', 'COMMISSARY_MANAGER')
        .executeTakeFirstOrThrow();
      const postPermission = await db!
        .selectFrom('auth.permissions')
        .select('id')
        .where('module_key', '=', 'supplier_receipts')
        .where('action_key', '=', 'post')
        .executeTakeFirstOrThrow();
      expect(
        await db!
          .selectFrom('auth.role_permissions')
          .select('role_id')
          .where('role_id', '=', manager.id)
          .where('permission_id', '=', postPermission.id)
          .executeTakeFirst(),
      ).toBeDefined();

      await expect(supplierFinal.up(db!)).rejects.toThrow(/1 draft receipt/);
      expect(
        await db!
          .selectFrom('supplier_receipts')
          .select('status')
          .where('id', '=', receiptId)
          .executeTakeFirstOrThrow(),
      ).toMatchObject({ status: 'DRAFT' });

      await db!
        .updateTable('supplier_receipts')
        .set({
          status: 'POSTED',
          posted_by_user_id: actorId,
          posted_at: new Date('2026-09-20T04:00:00.000Z'),
        })
        .where('id', '=', receiptId)
        .execute();
      const customRole = await db!
        .insertInto('auth.roles')
        .values({ role_name: 'Workflow Custom', code: `WORKFLOW_${randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase()}` })
        .returning('id')
        .executeTakeFirstOrThrow();
      await db!
        .insertInto('auth.role_permissions')
        .values({ role_id: customRole.id, permission_id: postPermission.id })
        .execute();
      await expect(supplierFinal.up(db!)).rejects.toThrow(/review supplier_receipts\.post grants/);
      await db!.deleteFrom('auth.role_permissions').where('role_id', '=', customRole.id).execute();
      await db!.deleteFrom('auth.roles').where('id', '=', customRole.id).execute();

      await supplierFinal.up(db!);
      const columns = await sql`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'supplier_receipts'
      `.execute(db!);
      expect(columns.rows.map((row: any) => row.column_name)).toContain('recorded_at');
      expect(columns.rows.map((row: any) => row.column_name)).not.toContain('status');
      expect(
        await db!
          .selectFrom('supplier_receipts')
          .select(['recorded_by_user_id', 'recorded_at'])
          .where('id', '=', receiptId)
          .executeTakeFirstOrThrow(),
      ).toMatchObject({ recorded_by_user_id: actorId });
      expect(
        await db!
          .selectFrom('auth.permissions')
          .select('id')
          .where('module_key', '=', 'supplier_receipts')
          .where('action_key', '=', 'post')
          .executeTakeFirst(),
      ).toBeUndefined();

      await supplierFinal.down(db!);
      const draftAfterRollback = await db!
        .insertInto('supplier_receipts')
        .values({
          supplier_id: supplierId,
          received_at: '2026-09-21',
          idempotency_key: randomUUID(),
          created_by_user_id: actorId,
        })
        .returning(['id', 'status', 'posted_by_user_id', 'posted_at'])
        .executeTakeFirstOrThrow();
      expect(draftAfterRollback).toMatchObject({
        status: 'DRAFT',
        posted_by_user_id: null,
        posted_at: null,
      });
      await db!
        .updateTable('supplier_receipts')
        .set({
          status: 'POSTED',
          posted_by_user_id: actorId,
          posted_at: new Date('2026-09-21T04:00:00.000Z'),
        })
        .where('id', '=', draftAfterRollback.id)
        .execute();
      expect(
        await db!
          .selectFrom('supplier_receipts')
          .select(['status', 'posted_by_user_id'])
          .where('id', '=', receiptId)
          .executeTakeFirstOrThrow(),
      ).toMatchObject({ status: 'POSTED', posted_by_user_id: actorId });
      const restoredPostPermission = await db!
        .selectFrom('auth.permissions')
        .select('id')
        .where('module_key', '=', 'supplier_receipts')
        .where('action_key', '=', 'post')
        .executeTakeFirstOrThrow();
      expect(
        await db!
          .selectFrom('auth.role_permissions')
          .select('role_id')
          .where('role_id', '=', manager.id)
          .where('permission_id', '=', restoredPostPermission.id)
          .executeTakeFirst(),
      ).toBeDefined();
    });

    it('backfills direct dispatch items, retires request grants, and refuses unsafe rollback', async () => {
      const branchManager = await db!
        .selectFrom('auth.roles')
        .select('id')
        .where('code', '=', 'BRANCH_MANAGER')
        .executeTakeFirstOrThrow();
      const legacyPermission = await db!
        .selectFrom('auth.permissions')
        .select('id')
        .where('module_key', '=', 'stock_requests')
        .where('action_key', '=', 'create')
        .executeTakeFirstOrThrow();
      requestId = (
        await db!
          .insertInto('stock_requests')
          .values({
            branch_id: branchId,
            requested_by_user_id: actorId,
            status: 'APPROVED',
            idempotency_key: randomUUID(),
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      requestItemId = (
        await db!
          .insertInto('stock_request_items')
          .values({ stock_request_id: requestId, stock_item_id: stockItemId, quantity_requested: '4.5' })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      dispatchId = (
        await db!
          .insertInto('dispatches')
          .values({ stock_request_id: requestId, branch_id: branchId, created_by_user_id: actorId, idempotency_key: randomUUID() })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      await db!
        .insertInto('dispatch_items')
        .values({ dispatch_id: dispatchId, stock_request_item_id: requestItemId, quantity_dispatched: '4.5' })
        .execute();

      const customRole = await db!
        .insertInto('auth.roles')
        .values({ role_name: 'Workflow Request Role', code: `REQUEST_${randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase()}` })
        .returning('id')
        .executeTakeFirstOrThrow();
      await db!
        .insertInto('auth.role_permissions')
        .values({ role_id: customRole.id, permission_id: legacyPermission.id })
        .execute();
      await expect(directDispatch.up(db!)).rejects.toThrow(/review legacy stock-request grants/);
      await db!.deleteFrom('auth.role_permissions').where('role_id', '=', customRole.id).execute();
      await db!.deleteFrom('auth.roles').where('id', '=', customRole.id).execute();
      await supplierFinal.up(db!);
      await directDispatch.up(db!);
      const permissions = await db!
        .selectFrom('auth.permissions')
        .select(['module_key', 'action_key', 'description'])
        .orderBy('module_key')
        .orderBy('action_key')
        .execute();
      expect(permissions).toEqual(
        [...PERMISSION_CATALOG].sort((left, right) =>
          `${left.module_key}.${left.action_key}`.localeCompare(
            `${right.module_key}.${right.action_key}`,
          ),
        ),
      );
      expect(
        await db!
          .selectFrom('dispatch_items')
          .select(['stock_item_id', 'stock_request_item_id'])
          .where('dispatch_id', '=', dispatchId)
          .executeTakeFirstOrThrow(),
      ).toMatchObject({ stock_item_id: stockItemId, stock_request_item_id: requestItemId });
      expect(
        await db!
          .selectFrom('auth.permissions')
          .select('module_key')
          .where('module_key', '=', 'stock_requests')
          .execute(),
      ).toEqual([]);
      expect(
        await db!
          .selectFrom('auth.role_permissions')
          .select('role_id')
          .where('role_id', '=', branchManager.id)
          .where('permission_id', '=', legacyPermission.id)
          .executeTakeFirst(),
      ).toBeUndefined();

      await directDispatch.down(db!);
      const restoredPermission = await db!
        .selectFrom('auth.permissions')
        .select('id')
        .where('module_key', '=', 'stock_requests')
        .where('action_key', '=', 'create')
        .executeTakeFirstOrThrow();
      expect(
        await db!
          .selectFrom('auth.role_permissions')
          .select('role_id')
          .where('role_id', '=', branchManager.id)
          .where('permission_id', '=', restoredPermission.id)
          .executeTakeFirst(),
      ).toBeDefined();

      await directDispatch.up(db!);
      const directId = (
        await db!
          .insertInto('dispatches')
          .values({ stock_request_id: null, branch_id: branchId, created_by_user_id: actorId, idempotency_key: randomUUID() })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      await db!
        .insertInto('dispatch_items')
        .values({ dispatch_id: directId, stock_item_id: stockItemId, stock_request_item_id: null, quantity_dispatched: '1' })
        .execute();
      await expect(directDispatch.down(db!)).rejects.toThrow(/will not invent request history/);
    });
  },
);
