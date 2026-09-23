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

describe.skipIf(process.env.COMS_RUN_DB_TESTS !== '1')(
  'dispatches and transit migration',
  () => {
    const databaseName = `coms_dispatches_test_${randomUUID().replaceAll('-', '')}`;
    let admin: Pool | undefined;
    let testDb: Kysely<any> | undefined;
    let migrator: Migrator | undefined;
    let actorId: string;
    let branchId: string;
    let stockItemId: string;
    let stockRequestId: string;
    let requestItemId: string;

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

      const migrations = {
        '20260920174538_auth': initial,
        '20260921120000_auth_token_rotation': rotation,
        '20260922164052_auth_rate_limits': limits,
        '20260923214210_access_control': accessControl,
        '20260924004212_operational_catalogs': catalogs,
        '20260924012454_inventory_ledger': inventory,
        '20260924014633_supplier_receipts': supplierReceipts,
        '20260924033004_stock_requests': stockRequests,
        '20260924042448_dispatches_and_transit': dispatchesAndTransit,
      };
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
      actorId = (
        await testDb
          .insertInto('auth.users')
          .values({
            email: `dispatch-migration-${randomUUID()}@example.com`,
            full_name: 'Dispatch Migration Test User',
            contact_number: `DM-${randomUUID().slice(0, 12)}`,
            hashed_password: 'test-only-hash',
            role_id: noAccessRole.id,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      branchId = (
        await testDb
          .insertInto('branches')
          .values({
            code: `DM-${randomUUID().slice(0, 8)}`,
            branch_name: 'Dispatch Migration Test Branch',
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      stockItemId = (
        await testDb
          .insertInto('stock_items')
          .values({
            stock_item_name: `Dispatch Migration Flour ${randomUUID()}`,
            category: 'Baking',
            unit: 'kg',
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      stockRequestId = (
        await testDb
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
        await testDb
          .insertInto('stock_request_items')
          .values({
            stock_request_id: stockRequestId,
            stock_item_id: stockItemId,
            quantity_requested: '12.5000',
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

    it('includes dispatch, receipt, shortage, audit, and ledger link schema on a fresh database', async () => {
      const schema = await sql
        .raw(
          "SELECT to_regclass('public.dispatches')::text AS dispatches, to_regclass('public.dispatch_items')::text AS dispatch_items, to_regclass('public.dispatch_receipts')::text AS dispatch_receipts, to_regclass('public.dispatch_receipt_items')::text AS dispatch_receipt_items, to_regclass('public.dispatch_shortage_closures')::text AS dispatch_shortage_closures, to_regclass('public.dispatch_shortage_closure_items')::text AS dispatch_shortage_closure_items, to_regclass('public.dispatch_events')::text AS dispatch_events",
        )
        .execute(testDb!);
      expect(schema.rows[0]).toEqual({
        dispatches: 'dispatches',
        dispatch_items: 'dispatch_items',
        dispatch_receipts: 'dispatch_receipts',
        dispatch_receipt_items: 'dispatch_receipt_items',
        dispatch_shortage_closures: 'dispatch_shortage_closures',
        dispatch_shortage_closure_items: 'dispatch_shortage_closure_items',
        dispatch_events: 'dispatch_events',
      });

      const columns = await sql<{ column_name: string }>`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'inventory_movements'
        ORDER BY ordinal_position
      `.execute(testDb!);
      expect(columns.rows.map((row) => row.column_name)).toContain(
        'dispatch_item_id',
      );
      expect(columns.rows.map((row) => row.column_name)).toContain(
        'dispatch_receipt_item_id',
      );

      const dispatchKey = randomUUID();
      const dispatch = await testDb!
        .insertInto('dispatches')
        .values({
          stock_request_id: stockRequestId,
          branch_id: branchId,
          created_by_user_id: actorId,
          idempotency_key: dispatchKey,
        })
        .returning(['id', 'status'])
        .executeTakeFirstOrThrow();
      expect(dispatch.status).toBe('DRAFT');
      await testDb!
        .insertInto('dispatch_events')
        .values({
          dispatch_id: dispatch.id,
          event_type: 'CREATED',
          actor_user_id: actorId,
          idempotency_key: dispatchKey,
        })
        .execute();
      const dispatchItem = await testDb!
        .insertInto('dispatch_items')
        .values({
          dispatch_id: dispatch.id,
          stock_request_item_id: requestItemId,
          quantity_dispatched: '12.5000',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const dispatchedMovement = await testDb!
        .insertInto('inventory_movements')
        .values({
          inventory_scope: 'COMMISSARY',
          stock_item_id: stockItemId,
          movement_type: 'DISPATCH',
          quantity_delta: '-12.5000',
          actor_user_id: actorId,
          dispatch_item_id: dispatchItem.id,
        })
        .returning('quantity_delta')
        .executeTakeFirstOrThrow();
      expect(dispatchedMovement.quantity_delta).toBe('-12.5000');
      await expect(
        testDb!
          .insertInto('inventory_movements')
          .values({
            inventory_scope: 'COMMISSARY',
            stock_item_id: stockItemId,
            movement_type: 'DISPATCH',
            quantity_delta: '-1',
            actor_user_id: actorId,
            dispatch_item_id: dispatchItem.id,
          })
          .execute(),
      ).rejects.toHaveProperty('code', '23505');

      const receiptKey = randomUUID();
      const receipt = await testDb!
        .insertInto('dispatch_receipts')
        .values({
          dispatch_id: dispatch.id,
          received_by_user_id: actorId,
          idempotency_key: receiptKey,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const receiptItem = await testDb!
        .insertInto('dispatch_receipt_items')
        .values({
          dispatch_receipt_id: receipt.id,
          dispatch_item_id: dispatchItem.id,
          quantity_received: '7.5000',
        })
        .returning(['id', 'quantity_received'])
        .executeTakeFirstOrThrow();
      expect(receiptItem.quantity_received).toBe('7.5000');
      await testDb!
        .insertInto('dispatch_events')
        .values({
          dispatch_id: dispatch.id,
          event_type: 'RECEIPT_RECORDED',
          actor_user_id: actorId,
          idempotency_key: receiptKey,
          dispatch_receipt_id: receipt.id,
        })
        .execute();
      await testDb!
        .insertInto('inventory_movements')
        .values({
          inventory_scope: 'BRANCH',
          branch_id: branchId,
          stock_item_id: stockItemId,
          movement_type: 'TRANSFER_IN',
          quantity_delta: '7.5000',
          actor_user_id: actorId,
          dispatch_receipt_item_id: receiptItem.id,
        })
        .execute();

      const shortageKey = randomUUID();
      const closure = await testDb!
        .insertInto('dispatch_shortage_closures')
        .values({
          dispatch_id: dispatch.id,
          closed_by_user_id: actorId,
          idempotency_key: shortageKey,
          reason: 'Verified missing during branch receiving',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await testDb!
        .insertInto('dispatch_shortage_closure_items')
        .values({
          shortage_closure_id: closure.id,
          dispatch_item_id: dispatchItem.id,
          quantity_closed: '1.2500',
        })
        .execute();
      await testDb!
        .insertInto('dispatch_events')
        .values({
          dispatch_id: dispatch.id,
          event_type: 'SHORTAGE_CLOSED',
          actor_user_id: actorId,
          idempotency_key: shortageKey,
          shortage_closure_id: closure.id,
        })
        .execute();

      const remaining = await sql<{ quantity_in_transit: string }>`
        SELECT (
          di.quantity_dispatched
          - coalesce((
            SELECT sum(dri.quantity_received)
            FROM dispatch_receipt_items dri
            WHERE dri.dispatch_item_id = di.id
          ), 0)
          - coalesce((
            SELECT sum(dsci.quantity_closed)
            FROM dispatch_shortage_closure_items dsci
            WHERE dsci.dispatch_item_id = di.id
          ), 0)
        )::text AS quantity_in_transit
        FROM dispatch_items di
        WHERE di.id = ${dispatchItem.id}
      `.execute(testDb!);
      expect(remaining.rows[0].quantity_in_transit).toBe('3.7500');

      await expect(
        testDb!
          .insertInto('dispatch_shortage_closures')
          .values({
            dispatch_id: dispatch.id,
            closed_by_user_id: actorId,
            idempotency_key: randomUUID(),
            reason: '   ',
          })
          .execute(),
      ).rejects.toHaveProperty('code', '23514');

      const inventoryMovementCount = await testDb!
        .selectFrom('inventory_movements')
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .executeTakeFirstOrThrow();
      expect(Number(inventoryMovementCount.count)).toBe(2);

      expect((await migrator!.migrateDown()).error).toBeUndefined();
      const remainingSchema = await sql
        .raw(
          "SELECT to_regclass('public.dispatches')::text AS dispatches, to_regclass('public.dispatch_items')::text AS dispatch_items, to_regclass('public.dispatch_receipts')::text AS dispatch_receipts, to_regclass('public.dispatch_receipt_items')::text AS dispatch_receipt_items, to_regclass('public.dispatch_shortage_closures')::text AS shortage_closures, to_regclass('public.dispatch_shortage_closure_items')::text AS shortage_closure_items, to_regclass('public.dispatch_events')::text AS dispatch_events, to_regclass('public.inventory_movements')::text AS inventory_movements, to_regclass('public.stock_requests')::text AS stock_requests, to_regclass('public.branches')::text AS branches, to_regclass('auth.users')::text AS users",
        )
        .execute(testDb!);
      expect(remainingSchema.rows[0]).toEqual({
        dispatches: null,
        dispatch_items: null,
        dispatch_receipts: null,
        dispatch_receipt_items: null,
        shortage_closures: null,
        shortage_closure_items: null,
        dispatch_events: null,
        inventory_movements: 'inventory_movements',
        stock_requests: 'stock_requests',
        branches: 'branches',
        users: 'auth.users',
      });
      const movementColumns = await sql<{ column_name: string }>`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'inventory_movements'
      `.execute(testDb!);
      expect(movementColumns.rows.map((row) => row.column_name)).not.toContain(
        'dispatch_item_id',
      );
      expect(movementColumns.rows.map((row) => row.column_name)).not.toContain(
        'dispatch_receipt_item_id',
      );
      const preservedUser = await testDb!
        .selectFrom('auth.users')
        .select('id')
        .where('id', '=', actorId)
        .executeTakeFirst();
      expect(preservedUser?.id).toBe(actorId);
    });
  },
);
