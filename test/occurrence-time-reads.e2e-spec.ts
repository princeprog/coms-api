import '../src/config/load-env';
import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { createDatabase } from '../src/database/create-database';
import type { DB } from '../src/database/db';
import { DailyReportsRepository } from '../src/modules/daily-reports/daily-reports.repository';
import { DashboardRepository } from '../src/modules/dashboard/dashboard.repository';
import { DashboardTodayRepository } from '../src/modules/dashboard/dashboard-today.repository';
import { InventoryRepository } from '../src/modules/inventory/inventory.repository';
import { NotificationWriterRepository } from '../src/modules/notifications/notification-writer.repository';
import { SalesReportRepository } from '../src/modules/sales-report/sales-report.repository';
import { testProductCategoryId } from './product-category-fixture';
import { requireFinalizedOfflineSessions } from '../src/modules/daily-reports/report-offline-sessions';
import { PosOfflineRepository } from '../src/modules/pos-offline/pos-offline.repository';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

// This fixture deliberately leaves created_at at the real posting time.
describe.skipIf(!process.env.COMS_TEST_DATABASE_NAME)(
  'late-posted occurrence-time reads',
  () => {
    let db: Kysely<DB>;
    let branchId: string;
    let actorId: string;
    let stockId: string;
    let productId: string;
    let historicalAt: Date;
    let today: string;
    const businessDate = '2026-09-23';
    const saleIds: string[] = [];
    const raceBranchIds: string[] = [];

    beforeAll(async () => {
      const url = new URL(process.env.DATABASE_URL!);
      if (url.pathname !== `/${process.env.COMS_TEST_DATABASE_NAME}`)
        throw Error('Run with scripts/test-disposable-db.cjs');
      db = createDatabase(url.toString(), 4);
      const suffix = randomUUID();
      branchId = (
        await db
          .insertInto('branches')
          .values({
            code: `OCC-${suffix.slice(0, 8)}`,
            branch_name: 'Occurrence regression',
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      actorId = (
        await db
          .insertInto('coms_auth.users')
          .values({
            email: `${suffix}@occurrence.invalid`,
            full_name: 'Occurrence operator',
            contact_number: suffix.slice(0, 20),
            hashed_password: 'test-only',
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      stockId = (
        await db
          .insertInto('stock_items')
          .values({
            stock_item_name: `Occurrence stock ${suffix}`,
            category: 'Ingredient',
            unit: 'kg',
            created_at: new Date('2000-01-01T00:00:00Z'),
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      productId = (
        await db
          .insertInto('products')
          .values({
            product_name: `Occurrence product ${suffix}`,
            category_id: testProductCategoryId,
            price: '100',
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      const clock = (
        await sql<{ at: Date; today: string }>`
        SELECT coms_business_day_end(${businessDate}::date) - interval '1 second' AS at,
          coms_business_date(now())::text AS today
      `.execute(db)
      ).rows[0];
      historicalAt = clock.at;
      today = clock.today;
      for (const [status, amount] of [
        ['COMPLETED', '100'],
        ['VOIDED', '50'],
      ] as const) {
        const sale = await db
          .insertInto('sales')
          .values({
            branch_id: branchId,
            cashier_user_id: actorId,
            status,
            tender_method: 'Cash',
            total_amount: amount,
            idempotency_key: randomUUID(),
            occurred_at: historicalAt,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        saleIds.push(sale.id);
        await db
          .insertInto('sale_items')
          .values({
            sale_id: sale.id,
            product_id: productId,
            product_name_snapshot: 'Historical product',
            quantity: '1',
            unit_price: amount,
            line_total: amount,
          })
          .execute();
        await db
          .insertInto('sale_events')
          .values({
            sale_id: sale.id,
            event_type: 'COMPLETED',
            actor_user_id: actorId,
            occurred_at: historicalAt,
          })
          .execute();
        if (status === 'VOIDED')
          await db
            .insertInto('sale_events')
            .values({
              sale_id: sale.id,
              event_type: 'VOIDED',
              actor_user_id: actorId,
              reason: 'Void after reconnecting',
              idempotency_key: randomUUID(),
            })
            .execute();
      }
      await db
        .insertInto('branch_inventory')
        .values({
          branch_id: branchId,
          stock_item_id: stockId,
          quantity_on_hand: '8',
        })
        .execute();
      const saleItem = await db
        .selectFrom('sale_items')
        .select('id')
        .where('sale_id', '=', saleIds[0])
        .executeTakeFirstOrThrow();
      const consumption = await db
        .insertInto('sale_item_consumptions')
        .values({
          sale_item_id: saleItem.id,
          stock_item_id: stockId,
          quantity_consumed: '3',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      let saleMovementId: string | undefined;
      for (const [type, quantity, at] of [
        ['ADJUSTMENT', '10', new Date(historicalAt.getTime() - 86_400_000)],
        ['SALE', '-3', historicalAt],
        ['SALE_VOID', '1', new Date()],
      ] as const) {
        const movement = await db
          .insertInto('inventory_movements')
          .values({
            inventory_scope: 'BRANCH',
            branch_id: branchId,
            stock_item_id: stockId,
            movement_type: type,
            quantity_delta: quantity,
            occurred_at: at,
            reason: 'Occurrence regression',
            actor_user_id: actorId,
            ...(type === 'SALE'
              ? { sale_item_consumption_id: consumption.id }
              : {}),
            ...(type === 'SALE_VOID'
              ? { reversal_of_movement_id: saleMovementId }
              : {}),
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        if (type === 'SALE') saleMovementId = movement.id;
      }
    });

    afterEach(() => vi.unstubAllEnvs());
    afterAll(async () => {
      if (branchId) {
        const reports = db
          .selectFrom('daily_branch_reports')
          .select('id')
          .where('branch_id', 'in', [branchId, ...raceBranchIds]);
        const sessions = db
          .selectFrom('pos_offline_sessions')
          .select('id')
          .where('branch_id', 'in', [branchId, ...raceBranchIds]);
        const items = db
          .selectFrom('sale_items')
          .select('id')
          .where(
            'sale_id',
            'in',
            db
              .selectFrom('sales')
              .select('id')
              .where('branch_id', 'in', [branchId, ...raceBranchIds]),
          );
        await db
          .deleteFrom('pos_offline_transactions')
          .where('session_id', 'in', sessions)
          .execute();
        await db
          .deleteFrom('pos_offline_snapshots')
          .where('session_id', 'in', sessions)
          .execute();
        await db
          .deleteFrom('pos_offline_sessions')
          .where('branch_id', 'in', [branchId, ...raceBranchIds])
          .execute();
        await db
          .deleteFrom('pos_offline_devices')
          .where('branch_id', 'in', [branchId, ...raceBranchIds])
          .execute();
        await db
          .deleteFrom('notification_events')
          .where('branch_id', 'in', [branchId, ...raceBranchIds])
          .execute();
        await db
          .deleteFrom('register_shifts')
          .where('branch_id', 'in', [branchId, ...raceBranchIds])
          .execute();
        await db
          .deleteFrom('inventory_movements')
          .where('branch_id', 'in', [branchId, ...raceBranchIds])
          .execute();
        await db
          .deleteFrom('sale_events')
          .where(
            'sale_id',
            'in',
            db
              .selectFrom('sales')
              .select('id')
              .where('branch_id', 'in', [branchId, ...raceBranchIds]),
          )
          .execute();
        await db
          .deleteFrom('sale_item_consumptions')
          .where('sale_item_id', 'in', items)
          .execute();
        await db.deleteFrom('sale_items').where('id', 'in', items).execute();
        await db
          .deleteFrom('sales')
          .where('branch_id', 'in', [branchId, ...raceBranchIds])
          .execute();
        await db
          .deleteFrom('daily_branch_report_events')
          .where('daily_branch_report_id', 'in', reports)
          .execute();
        await db
          .deleteFrom('daily_branch_report_items')
          .where('daily_branch_report_id', 'in', reports)
          .execute();
        await db
          .deleteFrom('daily_branch_reports')
          .where('branch_id', 'in', [branchId, ...raceBranchIds])
          .execute();
        await db
          .deleteFrom('branch_inventory')
          .where('branch_id', 'in', [branchId, ...raceBranchIds])
          .execute();
        if (productId)
          await db.deleteFrom('products').where('id', '=', productId).execute();
        if (stockId)
          await db
            .deleteFrom('stock_items')
            .where('id', '=', stockId)
            .execute();
        await db
          .deleteFrom('branches')
          .where('id', 'in', [branchId, ...raceBranchIds])
          .execute();
        if (actorId)
          await db
            .deleteFrom('coms_auth.users')
            .where('id', '=', actorId)
            .execute();
      }
      await db?.destroy();
    });

    it('keeps historical sale totals and daily breakdowns out of today', async () => {
      const reports = new SalesReportRepository(db);
      const historical = { from: businessDate, to: businessDate };
      expect(await reports.totals(historical, [branchId])).toMatchObject({
        gross_sales: '150.00',
        net_sales: '100.00',
        sales_count: 1,
        void_amount: '50.00',
      });
      expect(
        (await reports.breakdowns(historical, [branchId])).daily,
      ).toMatchObject([
        { date: businessDate, net_sales: '100.00', sales_count: 1 },
      ]);
      expect(
        await new DashboardTodayRepository(db).totals([branchId]),
      ).toMatchObject({
        net_sales: '0.00',
        sales_count: 0,
      });
      expect(
        (await new DashboardTodayRepository(db).branches([branchId]))[0],
      ).toMatchObject({
        sales_count: 0,
        last_sale_at: null,
      });
      const rows = await db
        .selectFrom('sales')
        .select(['created_at', 'occurred_at'])
        .where('id', 'in', saleIds)
        .execute();
      for (const row of rows) {
        expect(row.occurred_at).toEqual(historicalAt);
        expect(row.created_at.getTime()).toBeGreaterThan(
          historicalAt.getTime(),
        );
      }
    });

    it('attributes completion to cashier time and a later void to server time', async () => {
      const dashboard = new DashboardRepository(db);
      const range = (date: string) => ({
        from: date,
        to: date,
        days: 1,
        startAt: new Date(date),
        endExclusiveAt: new Date(date),
      });
      expect(
        (await dashboard.overview(range(businessDate), branchId)).summary,
      ).toMatchObject({
        completed_sales_amount: '150',
        completed_sales_count: 2,
        voided_sales_count: 0,
      });
      const current = await dashboard.overview(range(today), branchId);
      expect(current.summary).toMatchObject({
        completed_sales_count: 0,
        voided_sales_amount: '50',
      });
      expect(current.sales_trend[0]).toMatchObject({
        date: today,
        voided_sales_count: 1,
      });
    });

    it('uses historical consumption in closing stock and the next day opening', async () => {
      const reports = new DailyReportsRepository(
        db,
        new NotificationWriterRepository(),
      );
      const previous = await reports.create(
        branchId,
        businessDate,
        randomUUID(),
        actorId,
      );
      expect(previous).toMatchObject({
        completed_sales_count: 2,
        voided_sales_count: 0,
      });
      expect(previous.items[0]).toMatchObject({
        stock_item_id: stockId,
        opening_quantity: '10',
        sale_consumption_quantity: '3',
        sale_void_reversal_quantity: '0',
        ledger_closing_quantity: '7',
      });
      const next = await reports.create(
        branchId,
        '2026-09-24',
        randomUUID(),
        actorId,
      );
      expect(next.items[0]).toMatchObject({
        opening_quantity: '7',
        sale_consumption_quantity: '0',
        ledger_closing_quantity: '7',
      });
    });

    it('preserves posting metadata while sorting and averaging stock by occurrence', async () => {
      const inventory = new InventoryRepository(db);
      const query = { page: 1, page_size: 10, stock_item_id: stockId };
      const movements = await inventory.listMovements(
        'BRANCH',
        branchId,
        query,
      );
      expect(movements.items.map((row) => row.movement_type)).toEqual([
        'SALE_VOID',
        'SALE',
        'ADJUSTMENT',
      ]);
      expect(movements.items[1].occurred_at).toEqual(historicalAt);
      expect(movements.items[1].created_at.getTime()).toBeGreaterThan(
        historicalAt.getTime(),
      );
      const balances = await inventory.listBranch(branchId, {
        page: 1,
        page_size: 10,
        search: 'Occurrence stock',
      });
      expect(
        balances.items.find((row) => row.id === stockId)?.avg_daily_use,
      ).toBe('0');
    });

    it('waits for a concurrent offline writer and then blocks submit and approval, including development', async () => {
      vi.stubEnv('NODE_ENV', 'development');
      const reports = new DailyReportsRepository(
        db,
        new NotificationWriterRepository(),
      );
      const date = '2026-09-25';
      const report = await reports.create(
        branchId,
        date,
        randomUUID(),
        actorId,
      );
      const shift = await db
        .insertInto('register_shifts')
        .values({
          branch_id: branchId,
          business_date: date,
          shift_number: 1,
          opened_by_user_id: actorId,
          opening_float: '0',
          open_idempotency_key: randomUUID(),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const deviceId = randomUUID();
      await db
        .insertInto('pos_offline_devices')
        .values({
          id: deviceId,
          branch_id: branchId,
          requested_by: actorId,
          name: 'Occurrence register',
          status: 'APPROVED',
          approved_by: actorId,
        })
        .execute();
      const held = deferred<number>();
      const release = deferred<void>();
      let sessionId: string;
      const writer = db.transaction().execute(async (tx) => {
        await tx
          .selectFrom('branches')
          .select('id')
          .where('id', '=', branchId)
          .forShare()
          .execute();
        await tx
          .selectFrom('register_shifts')
          .select('id')
          .where('id', '=', shift.id)
          .forUpdate()
          .execute();
        sessionId = (
          await tx
            .insertInto('pos_offline_sessions')
            .values({
              branch_id: branchId,
              shift_id: shift.id,
              cashier_id: actorId,
              device_id: deviceId,
              business_date: date,
              issued_at: sql<Date>`coms_business_day_start(${date}::date)`,
              cutoff_at: sql<Date>`coms_business_day_end(${date}::date)`,
            })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;
        held.resolve(
          (
            await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(
              tx,
            )
          ).rows[0].pid,
        );
        await release.promise;
      });
      void writer.catch(held.reject);
      const pid = await held.promise;
      const submission = reports.submit(branchId, report.id, actorId).then(
        () => null,
        (error) => error,
      );
      let blocked = false;
      try {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          const result = await sql<{ blocked: boolean }>`
            SELECT EXISTS (SELECT 1 FROM pg_stat_activity
              WHERE datname = current_database()
                AND ${pid} = ANY(pg_blocking_pids(pid))) AS blocked
          `.execute(db);
          if (result.rows[0].blocked) {
            blocked = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      } finally {
        release.resolve();
        await writer;
      }
      expect(blocked).toBe(true);
      expect(await submission).toMatchObject({
        response: { code: 'OFFLINE_SYNC_REQUIRED' },
      });
      expect((await reports.find(branchId, report.id)).status).toBe('DRAFT');
      await db
        .updateTable('daily_branch_reports')
        .set({
          status: 'SUBMITTED',
          submitted_at: new Date(),
          submitted_by_user_id: actorId,
        })
        .where('id', '=', report.id)
        .execute();
      await expect(
        reports.approve(branchId, report.id, actorId),
      ).rejects.toMatchObject({
        response: { code: 'OFFLINE_SYNC_REQUIRED' },
      });
      // Other dates are not blocked; finalized sessions no longer block either.
      await db.transaction().execute(async (tx) => {
        await tx
          .selectFrom('branches')
          .select('id')
          .where('id', '=', branchId)
          .forUpdate()
          .execute();
        await requireFinalizedOfflineSessions(tx, branchId, '2026-09-26');
      });
      await db
        .updateTable('pos_offline_sessions')
        .set({
          status: 'FINALIZED',
          final_sequence: 0,
          finalized_at: new Date(),
        })
        .where('id', '=', sessionId!)
        .execute();
      await db.transaction().execute(async (tx) => {
        await tx
          .selectFrom('branches')
          .select('id')
          .where('id', '=', branchId)
          .forUpdate()
          .execute();
        await requireFinalizedOfflineSessions(tx, branchId, date);
      });
    });

    it('rejects prepare after waiting for report approval to release the branch lock', async () => {
      const raceBranch = await db
        .insertInto('branches')
        .values({
          code: `RACE-${randomUUID().slice(0, 8)}`,
          branch_name: 'Prepare approval race',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      raceBranchIds.push(raceBranch.id);
      const deviceId = randomUUID();
      await db
        .insertInto('pos_offline_devices')
        .values({
          id: deviceId,
          branch_id: raceBranch.id,
          requested_by: actorId,
          name: 'Prepare race register',
          status: 'APPROVED',
          approved_by: actorId,
        })
        .execute();
      await db
        .insertInto('register_shifts')
        .values({
          branch_id: raceBranch.id,
          business_date: today,
          shift_number: 1,
          opened_by_user_id: actorId,
          opening_float: '0',
          open_idempotency_key: randomUUID(),
        })
        .execute();
      const notifications = new NotificationWriterRepository();
      const reports = new DailyReportsRepository(db, notifications);
      const report = await reports.create(
        raceBranch.id,
        today,
        randomUUID(),
        actorId,
      );
      await db
        .updateTable('daily_branch_reports')
        .set({
          status: 'SUBMITTED',
          submitted_at: new Date(),
          submitted_by_user_id: actorId,
        })
        .where('id', '=', report.id)
        .execute();

      const held = deferred<number>();
      const release = deferred<void>();
      // Approval has updated report status but still owns its branch/report locks
      // when it publishes. Hold that transaction until prepare is truly waiting.
      vi.spyOn(notifications, 'publish').mockImplementation(async (tx) => {
        held.resolve(
          (
            await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(
              tx,
            )
          ).rows[0].pid,
        );
        await release.promise;
        return 0;
      });
      const approval = reports.approve(raceBranch.id, report.id, actorId);
      void approval.catch(held.reject);
      const pid = await held.promise;
      const preparation = new PosOfflineRepository(db)
        .prepare(raceBranch.id, actorId, deviceId)
        .then(
          () => null,
          (error) => error,
        );
      let blocked = false;
      try {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          const result = await sql<{ blocked: boolean }>`
            SELECT EXISTS (SELECT 1 FROM pg_stat_activity
              WHERE datname = current_database()
                AND ${pid} = ANY(pg_blocking_pids(pid))) AS blocked
          `.execute(db);
          if (result.rows[0].blocked) {
            blocked = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      } finally {
        release.resolve();
        await approval;
      }
      expect(blocked).toBe(true);
      expect(await preparation).toMatchObject({
        response: {
          statusCode: 409,
          message:
            'The daily report is submitted or approved. This register cannot prepare another session.',
        },
      });
      expect((await reports.find(raceBranch.id, report.id)).status).toBe(
        'APPROVED',
      );
      expect(
        await db
          .selectFrom('pos_offline_sessions')
          .select('id')
          .where('branch_id', '=', raceBranch.id)
          .execute(),
      ).toEqual([]);
    });
  },
);
