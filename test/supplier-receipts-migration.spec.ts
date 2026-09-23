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

describe.skipIf(process.env.COMS_RUN_DB_TESTS !== '1')(
  'supplier receipts migration',
  () => {
    const databaseName = `coms_receipts_test_${randomUUID().replaceAll('-', '')}`;
    const legacyUser = {
      email: 'supplier-receipts-test@example.com',
      full_name: 'Supplier Receipts Test User',
      contact_number: 'supplier-receipts-test',
      hashed_password: 'existing-password-hash',
    };
    let admin: Pool | undefined;
    let testDb: Kysely<any> | undefined;
    let migrator: Migrator | undefined;
    let actorId: string;
    let supplierId: string;
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
          }),
        },
      });
      expect((await migrator.migrateToLatest()).error).toBeUndefined();

      const supplier = await testDb
        .insertInto('suppliers')
        .values({ supplier_name: 'Receipt Test Supplier' })
        .returning('id')
        .executeTakeFirstOrThrow();
      supplierId = supplier.id;
      const stockItem = await testDb
        .insertInto('stock_items')
        .values({
          stock_item_name: 'Receipt Test Flour',
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

    it('creates receipt and line constraints, links ledger entries, and rolls back only its own schema', async () => {
      const columns = await sql
        .raw(
          "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND ((table_name = 'supplier_receipts') OR (table_name = 'supplier_receipt_items') OR (table_name = 'inventory_movements' AND column_name = 'supplier_receipt_item_id')) ORDER BY table_name, ordinal_position",
        )
        .execute(testDb!);

      expect(columns.rows).toEqual([
        {
          table_name: 'inventory_movements',
          column_name: 'supplier_receipt_item_id',
        },
        { table_name: 'supplier_receipt_items', column_name: 'id' },
        {
          table_name: 'supplier_receipt_items',
          column_name: 'supplier_receipt_id',
        },
        {
          table_name: 'supplier_receipt_items',
          column_name: 'stock_item_id',
        },
        {
          table_name: 'supplier_receipt_items',
          column_name: 'quantity_received',
        },
        { table_name: 'supplier_receipt_items', column_name: 'unit_cost' },
        {
          table_name: 'supplier_receipt_items',
          column_name: 'created_at',
        },
        { table_name: 'supplier_receipts', column_name: 'id' },
        { table_name: 'supplier_receipts', column_name: 'supplier_id' },
        { table_name: 'supplier_receipts', column_name: 'received_at' },
        { table_name: 'supplier_receipts', column_name: 'status' },
        {
          table_name: 'supplier_receipts',
          column_name: 'idempotency_key',
        },
        {
          table_name: 'supplier_receipts',
          column_name: 'created_by_user_id',
        },
        {
          table_name: 'supplier_receipts',
          column_name: 'posted_by_user_id',
        },
        { table_name: 'supplier_receipts', column_name: 'posted_at' },
        { table_name: 'supplier_receipts', column_name: 'created_at' },
        { table_name: 'supplier_receipts', column_name: 'updated_at' },
      ]);

      const idempotencyKey = randomUUID();
      const receipt = await testDb!
        .insertInto('supplier_receipts')
        .values({
          supplier_id: supplierId,
          received_at: '2026-09-24',
          idempotency_key: idempotencyKey,
          created_by_user_id: actorId,
        })
        .returning(['id', 'status', 'posted_at', 'posted_by_user_id'])
        .executeTakeFirstOrThrow();
      expect(receipt).toMatchObject({
        status: 'DRAFT',
        posted_at: null,
        posted_by_user_id: null,
      });

      const item = await testDb!
        .insertInto('supplier_receipt_items')
        .values({
          supplier_receipt_id: receipt.id,
          stock_item_id: stockItemId,
          quantity_received: '12.5',
          unit_cost: '89.25',
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      const movement = await testDb!
        .insertInto('inventory_movements')
        .values({
          inventory_scope: 'COMMISSARY',
          branch_id: null,
          stock_item_id: stockItemId,
          movement_type: 'RECEIPT',
          quantity_delta: item.quantity_received,
          reason: 'Supplier receipt',
          actor_user_id: actorId,
          supplier_receipt_item_id: item.id,
        })
        .returning('supplier_receipt_item_id')
        .executeTakeFirstOrThrow();
      expect(movement.supplier_receipt_item_id).toBe(item.id);

      await expect(
        testDb!
          .insertInto('supplier_receipts')
          .values({
            supplier_id: supplierId,
            received_at: '2026-09-24',
            idempotency_key: idempotencyKey,
            created_by_user_id: actorId,
          })
          .execute(),
      ).rejects.toHaveProperty('code', '23505');
      await expect(
        testDb!
          .insertInto('supplier_receipt_items')
          .values({
            supplier_receipt_id: receipt.id,
            stock_item_id: stockItemId,
            quantity_received: '0',
            unit_cost: '10',
          })
          .execute(),
      ).rejects.toHaveProperty('code', '23514');
      await expect(
        testDb!
          .insertInto('supplier_receipt_items')
          .values({
            supplier_receipt_id: receipt.id,
            stock_item_id: stockItemId,
            quantity_received: '1',
            unit_cost: '-0.01',
          })
          .execute(),
      ).rejects.toHaveProperty('code', '23514');
      await expect(
        testDb!
          .updateTable('supplier_receipts')
          .set({ status: 'POSTED' })
          .where('id', '=', receipt.id)
          .execute(),
      ).rejects.toHaveProperty('code', '23514');

      expect((await migrator!.migrateDown()).error).toBeUndefined();
      const remainingSchema = await sql
        .raw(
          "SELECT to_regclass('public.supplier_receipts')::text AS supplier_receipts, to_regclass('public.supplier_receipt_items')::text AS supplier_receipt_items, to_regclass('public.inventory_movements')::text AS inventory_movements, to_regclass('public.commissary_inventory')::text AS commissary_inventory, to_regclass('public.stock_items')::text AS stock_items, to_regclass('public.suppliers')::text AS suppliers, to_regclass('public.branches')::text AS branches, to_regclass('auth.users')::text AS users",
        )
        .execute(testDb!);
      expect(remainingSchema.rows[0]).toEqual({
        supplier_receipts: null,
        supplier_receipt_items: null,
        inventory_movements: 'inventory_movements',
        commissary_inventory: 'commissary_inventory',
        stock_items: 'stock_items',
        suppliers: 'suppliers',
        branches: 'branches',
        users: 'auth.users',
      });
      const receiptItemColumn = await sql
        .raw(
          "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'inventory_movements' AND column_name = 'supplier_receipt_item_id'",
        )
        .execute(testDb!);
      expect(receiptItemColumn.rows).toEqual([]);
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
