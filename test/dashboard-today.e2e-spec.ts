import '../src/config/load-env';
import {
  ValidationPipe,
  type ExecutionContext,
  type INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { sql, type Kysely } from 'kysely';
import { Migrator } from 'kysely/migration';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { AuthGatewayGuard } from '../src/common/guards/auth-gateway.guard';
import { AuthGuard } from '../src/common/guards/auth.guard';
import { createDatabase } from '../src/database/create-database';
import { DATABASE } from '../src/database/database.module';
import type { DB } from '../src/database/db';
import { testProductCategoryId } from './product-category-fixture';
import { openTestShift } from './shift-fixture';

describe.skipIf(process.env.COMS_RUN_DB_TESTS !== '1')(
  'today dashboard',
  () => {
    const name = 'coms_today_test_' + randomUUID().replaceAll('-', '');
    let admin: Pool;
    let db: Kysely<DB>;
    let app: INestApplication;
    let owner: string, manager: string, outsider: string;
    let branchA: string, branchB: string;
    const as = (actor: string) => ({
      get: (path: string) =>
        request(app.getHttpServer()).get(path).set('x-test-actor', actor),
      post: (path: string) =>
        request(app.getHttpServer()).post(path).set('x-test-actor', actor),
    });
    const counts = (attention: { key: string; count: number }[]) =>
      Object.fromEntries(attention.map((item) => [item.key, item.count]));

    beforeAll(async () => {
      const url = new URL(
        process.env.COMS_TEST_ADMIN_URL ?? process.env.DATABASE_URL!,
      );
      if (!['localhost', '127.0.0.1'].includes(url.hostname))
        throw Error('Use a verified loopback target');
      admin = new Pool({ connectionString: url.toString() });
      await admin.query(`CREATE DATABASE "${name}"`);
      url.pathname = '/' + name;
      db = createDatabase(url.toString(), 4);
      const migrations: Record<string, unknown> = {};
      for (const file of readdirSync('src/database/migrations')
        .filter((f) => f.endsWith('.ts'))
        .sort())
        migrations[file.slice(0, -3)] = await import(
          '../src/database/migrations/' + file
        );
      const migrated = await new Migrator({
        db,
        provider: { getMigrations: async () => migrations as never },
      }).migrateToLatest();
      if (migrated.error) throw migrated.error;
      const module = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(DATABASE)
        .useValue(db)
        .overrideGuard(AuthGatewayGuard)
        .useValue({ canActivate: () => true })
        .overrideGuard(AuthGuard)
        .useValue({
          canActivate: (ctx: ExecutionContext) => {
            const req = ctx.switchToHttp().getRequest();
            req.user = { id: req.headers['x-test-actor'] };
            return true;
          },
        })
        .compile();
      app = module.createNestApplication();
      app.useGlobalPipes(
        new ValidationPipe({
          whitelist: true,
          forbidNonWhitelisted: true,
          transform: true,
        }),
      );
      await app.init();

      const role = async (code: string, permissions: string[]) => {
        const created = await db
          .insertInto('auth.roles')
          .values({ code, role_name: code })
          .returning('id')
          .executeTakeFirstOrThrow();
        for (const key of permissions) {
          const [module_key, action_key] = key.split('.');
          await sql`INSERT INTO auth.role_permissions (role_id, permission_id)
          SELECT ${created.id}, id FROM auth.permissions
          WHERE module_key = ${module_key} AND action_key = ${action_key}`.execute(
            db,
          );
        }
        return created.id;
      };
      const user = async (label: string, roleId: string) =>
        (
          await db
            .insertInto('auth.users')
            .values({
              email: `${label}@today.invalid`,
              full_name: 'Today ' + label,
              contact_number: 'today-' + label,
              hashed_password: 'test-only',
              role_id: roleId,
            })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;
      const superRole = (
        await db
          .selectFrom('auth.roles')
          .select('id')
          .where('code', '=', 'SUPER_ADMIN')
          .executeTakeFirstOrThrow()
      ).id;
      owner = await user('owner', superRole);
      const cashierRole = await role('TODAY_CASHIER', [
        'sales.create',
        'sales.read',
        'sales.void',
      ]);
      const cashierA = await user('cashier-a', cashierRole);
      const cashierB = await user('cashier-b', cashierRole);
      manager = await user(
        'manager',
        await role('TODAY_MANAGER', [
          'dashboard.read',
          'daily_reports.read',
          'dispatches.read',
          'shifts.read',
          'inventory.read',
        ]),
      );
      outsider = await user(
        'outsider',
        await role('TODAY_NONE', ['sales.read']),
      );
      const newBranch = async (code: string) =>
        (
          await db
            .insertInto('branches')
            .values({ code, branch_name: 'Today ' + code, has_dine_in: true })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;
      branchA = await newBranch('TDY-A');
      branchB = await newBranch('TDY-B');
      await db
        .insertInto('auth.branch_users')
        .values([
          { branch_id: branchA, user_id: cashierA },
          { branch_id: branchB, user_id: cashierB },
          { branch_id: branchA, user_id: manager },
          { branch_id: branchA, user_id: outsider },
        ])
        .execute();
      await openTestShift(db, branchA, cashierA);
      const shiftB = await openTestShift(db, branchB, cashierB);

      const stock = async (stock_item_name: string, cost: string) => {
        const id = (
          await db
            .insertInto('stock_items')
            .values({ stock_item_name, category: 'Today test', unit: 'kg' })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;
        await db
          .insertInto('stock_item_costs')
          .values({
            stock_item_id: id,
            average_unit_cost: cost,
            cost_source: 'MANUAL',
          })
          .execute();
        return id;
      };
      const rice = await stock('Today rice', '50');
      const box = await stock('Today box', '6');
      await db
        .insertInto('commissary_inventory')
        .values({
          stock_item_id: rice,
          quantity_on_hand: '-3',
        })
        .execute();
      const product = async (product_name: string, price: string) => {
        const id = (
          await db
            .insertInto('products')
            .values({ product_name, price, category_id: testProductCategoryId })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;
        await db
          .insertInto('branch_products')
          .values([
            { branch_id: branchA, product_id: id, price },
            { branch_id: branchB, product_id: id, price },
          ])
          .execute();
        return id;
      };
      const meal = await product('Today meal', '150');
      const drink = await product('Today drink', '50');
      await db
        .insertInto('product_ingredients')
        .values([
          { product_id: meal, stock_item_id: rice, quantity_required: '1' },
          {
            product_id: meal,
            stock_item_id: box,
            quantity_required: '1',
            usage_scope: 'TAKEAWAY',
          },
        ])
        .execute();

      const sell = async (
        cashier: string,
        branch: string,
        productId: string,
        quantity: string,
        service: 'DINE_IN' | 'TAKEAWAY',
      ) => {
        const sale = await as(cashier)
          .post(`/branches/${branch}/sales`)
          .set('Idempotency-Key', randomUUID())
          .send({
            service_type: service,
            tender_method: 'Cash',
            items: [{ product_id: productId, quantity, price_revision: 1 }],
          });
        expect(sale.status, JSON.stringify(sale.body)).toBe(201);
        return sale.body.id as string;
      };
      // Branch A today: 300 takeout (food cost 2 × 56) + 50 drink; one void.
      await sell(cashierA, branchA, meal, '2', 'TAKEAWAY');
      await sell(cashierA, branchA, drink, '1', 'DINE_IN');
      const voided = await sell(cashierA, branchA, meal, '1', 'DINE_IN');
      await as(cashierA)
        .post(`/branches/${branchA}/sales/${voided}/void`)
        .set('Idempotency-Key', randomUUID())
        .send({ reason: 'Wrong order' });
      // Branch A yesterday at this time: 150.
      const earlier = await sell(cashierA, branchA, meal, '1', 'DINE_IN');
      await sql`UPDATE sales SET created_at = created_at - interval '1 day' WHERE id = ${earlier}::uuid`.execute(
        db,
      );
      // Branch A on the same weekday last week, at this time: 150.
      const lastWeek = await sell(cashierA, branchA, meal, '1', 'DINE_IN');
      await sql`UPDATE sales SET created_at = created_at - interval '7 days' WHERE id = ${lastWeek}::uuid`.execute(
        db,
      );
      // Branch B today: 100; its shift is then left open from two days ago.
      await sell(cashierB, branchB, drink, '2', 'DINE_IN');
      await sql`UPDATE register_shifts SET business_date = business_date - 2 WHERE id = ${shiftB}::uuid`.execute(
        db,
      );

      // Branch A: a closed shift from yesterday that came up short.
      await sql`INSERT INTO register_shifts (branch_id, business_date, shift_number, opened_by_user_id,
        opening_float, open_idempotency_key, opened_at, status, closed_at, counted_cash, left_in_drawer,
        expected_cash, cash_difference, close_type, closed_by_user_id, close_idempotency_key)
      VALUES (${branchA}::uuid, coms_business_date(now()) - 1, 1, ${cashierA}::uuid, 0, ${randomUUID()}::uuid,
        now() - interval '1 day', 'CLOSED', now() - interval '20 hours', 480, 0, 500, -20, 'CASHIER',
        ${cashierA}::uuid, ${randomUUID()}::uuid)`.execute(db);

      const dispatch = async (branch: string, receiveBy: string) =>
        (
          await sql<{
            id: string;
          }>`INSERT INTO dispatches (branch_id, status, idempotency_key,
            created_by_user_id, dispatched_by_user_id, dispatched_at, receive_by)
          VALUES (${branch}::uuid, 'IN_TRANSIT', ${randomUUID()}::uuid, ${owner}::uuid, ${owner}::uuid,
            now() - interval '2 days', now() + ${receiveBy}::interval) RETURNING id`.execute(
            db,
          )
        ).rows[0].id;
      const overdueA = await dispatch(branchA, '-1 hour');
      await dispatch(branchA, '1 day');
      await dispatch(branchB, '-3 hours');
      // A drafted dispatch that has not been sent.
      await sql`INSERT INTO dispatches (branch_id, status, idempotency_key, created_by_user_id)
        VALUES (${branchA}::uuid, 'DRAFT', ${randomUUID()}::uuid, ${owner}::uuid)`.execute(
        db,
      );
      await db
        .insertInto('dispatch_discrepancies')
        .values({
          dispatch_id: overdueA,
          reported_by_user_id: owner,
          idempotency_key: randomUUID(),
        })
        .execute();
      await db
        .insertInto('branch_inventory')
        .values({
          branch_id: branchA,
          stock_item_id: rice,
          quantity_on_hand: '-2',
        })
        .onConflict((oc) =>
          oc
            .columns(['branch_id', 'stock_item_id'])
            .doUpdateSet({ quantity_on_hand: '-2' }),
        )
        .execute();
      await db
        .insertInto('daily_branch_reports')
        .values({
          branch_id: branchA,
          business_date: sql<Date>`coms_business_date(now()) - 3`,
          status: 'SUBMITTED',
          idempotency_key: randomUUID(),
          created_by_user_id: manager,
          submitted_by_user_id: manager,
          submitted_at: sql<Date>`now()`,
        })
        .execute();
    }, 60000);

    afterAll(async () => {
      await app?.close();
      await db?.destroy();
      if (admin) {
        if (!name.startsWith('coms_today_test_')) throw Error('Unsafe cleanup');
        await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
        await admin.end();
      }
    });

    it('shows the owner every branch, profit and every attention item', async () => {
      const response = await as(owner).get('/dashboard/today');
      expect(response.status).toBe(200);
      const body = response.body;
      expect(body.scope_label).toBe('All branches');
      expect(body.today).toMatchObject({
        net_sales: '450.00',
        sales_count: 3,
        average_sale: '150.00',
        void_count: 1,
        food_cost: '112.00',
        gross_profit: '338.00',
        // Only the takeout meals have recipe costs: 300 of 450.
        cost_coverage_percent: '66.7',
      });
      expect(body.yesterday_same_time).toEqual({
        net_sales: '150.00',
        sales_count: 1,
      });
      expect(body.last_week_same_time).toEqual({
        net_sales: '150.00',
        sales_count: 1,
      });
      expect(body.changes).toEqual({
        net_sales: '200',
        sales_count: '200',
        net_sales_vs_yesterday: '200',
      });
      const sum = (rows: Record<string, string>[], key: string) =>
        rows.reduce((total, row) => total + Number(row[key]), 0);
      expect(body.hourly.length).toBeGreaterThan(0);
      expect(sum(body.hourly, 'net_sales')).toBe(450);
      expect(sum(body.hourly, 'last_week_net_sales')).toBe(150);
      expect(body.hourly.at(-1).hour).toMatch(/^\d{2}:00$/);
      expect(counts(body.attention)).toEqual({
        deliveries_overdue: 2,
        open_discrepancies: 1,
        shifts_open_past_day: 1,
        cash_shortages: 1,
        // Sales deducted rice and boxes below zero at branch A.
        stock_below_zero: 2,
        commissary_stock_below_zero: 1,
        // No reorder levels are set in this fixture.
        branch_stock_low: 0,
        commissary_stock_low: 0,
        reports_missing: 1,
        reports_returned: 0,
        reports_to_review: 1,
        late_counts_to_review: 0,
        shifts_to_review: 1,
        dispatches_draft: 1,
        deliveries_in_transit: 1,
        products_incomplete_costs: 1,
      });
      const a = body.branches.find(
        (b: { branch_id: string }) => b.branch_id === branchA,
      );
      expect(a).toMatchObject({
        net_sales: '350.00',
        sales_count: 2,
        cashier_name: 'Today cashier-a',
        yesterday_report_status: 'MISSING',
      });
      expect(body.last_7_days).toHaveLength(7);
      expect(body.last_7_days[6]).toMatchObject({
        net_sales: '450.00',
        gross_profit: '338.00',
      });
      expect(body.top_products_today[0]).toMatchObject({
        name: 'Today meal',
        quantity: '2',
        net_sales: '300.00',
      });
      expect(body.workspace).toBe('overview');
      const shortage = body.attention.find(
        (item: { key: string }) => item.key === 'cash_shortages',
      );
      expect(shortage).toMatchObject({
        amount: '20.00',
        branch_count: 1,
        example: { branch_id: branchA, branch_name: 'Today TDY-A' },
      });
      const deficit = body.attention.find(
        (item: { key: string }) => item.key === 'commissary_stock_below_zero',
      );
      expect(deficit.example).toMatchObject({
        label: 'Today rice',
        quantity: '-3',
        unit: 'kg',
      });
      expect(
        body.report_progress.find(
          (r: { branch_id: string; period: string }) =>
            r.branch_id === branchA && r.period === 'yesterday',
        ),
      ).toMatchObject({
        status: 'MISSING',
        report_id: null,
        total_items: null,
        counted_items: null,
        open_shifts: 0,
        unreviewed_shifts: 1,
        pending_deliveries: 2,
        day_ended: true,
      });
    });

    it('limits a branch manager to their branch and hides costs', async () => {
      const response = await as(manager).get('/dashboard/today');
      expect(response.status).toBe(200);
      const body = response.body;
      expect(body.scope_label).toBe('Today TDY-A');
      expect(body.show_costs).toBe(false);
      expect(body.today).toMatchObject({
        net_sales: '350.00',
        food_cost: null,
        gross_profit: null,
      });
      expect(
        body.branches.map((b: { branch_id: string }) => b.branch_id),
      ).toEqual([branchA]);
      const items = counts(body.attention);
      expect(items).not.toHaveProperty('products_incomplete_costs');
      expect(items).not.toHaveProperty('dispatches_draft');
      expect(items).not.toHaveProperty('commissary_stock_below_zero');
      expect(body.workspace).toBe('branch');
      expect(
        body.report_progress.every(
          (r: { branch_id: string }) => r.branch_id === branchA,
        ),
      ).toBe(true);
      expect(body.today.cost_coverage_percent).toBeNull();
      expect(items).toMatchObject({
        deliveries_overdue: 1,
        shifts_open_past_day: 0,
        // Sales deducted rice and boxes below zero at branch A.
        stock_below_zero: 2,
      });
      expect(body.last_7_days[6].gross_profit).toBeNull();
      expect(
        (await as(manager).get(`/dashboard/today?branch_id=${branchB}`)).status,
      ).toBe(403);
      expect((await as(outsider).get('/dashboard/today')).status).toBe(403);
      const filtered = await as(owner).get(
        `/dashboard/today?branch_id=${branchB}`,
      );
      expect(filtered.body.today.net_sales).toBe('100.00');
      expect(counts(filtered.body.attention)).toMatchObject({
        deliveries_overdue: 1,
        shifts_open_past_day: 1,
        commissary_stock_below_zero: 0,
      });
      expect(
        filtered.body.attention.find(
          (item: { key: string }) => item.key === 'commissary_stock_below_zero',
        ).example,
      ).toBeNull();
      expect(
        body.attention.find(
          (item: { key: string }) => item.key === 'deliveries_overdue',
        ).example.branch_id,
      ).toBe(branchA);
    });

    it('counts saved report items, including excluded items and empty reports, and prioritizes corrections', async () => {
      const stocks = await db
        .selectFrom('stock_items')
        .select('id')
        .orderBy('id')
        .limit(2)
        .execute();
      const report = await db
        .insertInto('daily_branch_reports')
        .values({
          branch_id: branchA,
          business_date: sql<Date>`coms_business_date(now())`,
          idempotency_key: randomUUID(),
          created_by_user_id: manager,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await db
        .insertInto('daily_branch_report_items')
        .values(
          stocks.map((stock, index) => ({
            daily_branch_report_id: report.id,
            stock_item_id: stock.id,
            opening_quantity: '0',
            receipt_quantity: '0',
            sale_consumption_quantity: '0',
            sale_void_reversal_quantity: '0',
            ledger_adjustment_quantity: '0',
            ledger_closing_quantity: '0',
            expected_closing_quantity: '0',
            physical_closing_quantity: index === 0 ? '0' : null,
          })),
        )
        .execute();
      await db
        .updateTable('stock_items')
        .set({ daily_count_required: false })
        .where('id', '=', stocks[0].id)
        .execute();
      await db
        .insertInto('daily_branch_reports')
        .values({
          branch_id: branchB,
          business_date: sql<Date>`coms_business_date(now()) - 1`,
          status: 'RETURNED',
          idempotency_key: randomUUID(),
          created_by_user_id: owner,
          submitted_at: new Date(),
          submitted_by_user_id: manager,
          reviewed_at: new Date(),
          reviewed_by_user_id: owner,
          return_reason: 'Recheck the closing count',
        })
        .execute();
      const body = (await as(owner).get('/dashboard/today').expect(200)).body;
      expect(
        body.report_progress.find(
          (r: { report_id: string }) => r.report_id === report.id,
        ),
      ).toMatchObject({
        status: 'DRAFT',
        total_items: 2,
        counted_items: 1,
        open_shifts: 1,
        day_ended: false,
      });
      expect(
        body.report_progress.find(
          (r: { branch_id: string; period: string }) =>
            r.branch_id === branchB && r.period === 'yesterday',
        ),
      ).toMatchObject({
        status: 'RETURNED',
        total_items: 0,
        counted_items: 0,
      });
      expect(body.branches[0].branch_id).toBe(branchB);
    });

    it('does not disclose report progress or deep links after read permissions are removed', async () => {
      const { role_id } = await db
        .selectFrom('auth.users')
        .select('role_id')
        .where('id', '=', manager)
        .executeTakeFirstOrThrow();
      const grants = await db
        .selectFrom('auth.role_permissions as rp')
        .innerJoin('auth.permissions as p', 'p.id', 'rp.permission_id')
        .select(['rp.role_id', 'rp.permission_id'])
        .where('rp.role_id', '=', role_id!)
        .where('p.module_key', 'in', ['daily_reports', 'shifts'])
        .execute();
      try {
        await db
          .deleteFrom('auth.role_permissions')
          .where('role_id', '=', role_id!)
          .where(
            'permission_id',
            'in',
            grants.map((g) => g.permission_id),
          )
          .execute();
        const body = (await as(manager).get('/dashboard/today').expect(200))
          .body;
        expect(body.report_progress).toEqual([]);
        expect(body.access).toMatchObject({ reports: false, shifts: false });
        expect(body.branches[0]).toMatchObject({
          yesterday_report_status: null,
          shift_id: null,
        });
        expect(
          body.attention.some(
            (item: { key: string }) =>
              item.key.startsWith('reports_') || item.key.startsWith('shifts_'),
          ),
        ).toBe(false);
      } finally {
        await db.insertInto('auth.role_permissions').values(grants).execute();
      }
    });
  },
);
