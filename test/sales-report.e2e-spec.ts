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

describe.skipIf(process.env.COMS_RUN_DB_TESTS !== '1')('sales report', () => {
  const name = 'coms_report_test_' + randomUUID().replaceAll('-', '');
  let admin: Pool;
  let db: Kysely<DB>;
  let app: INestApplication;
  let owner: string, cashier: string, reader: string, costReader: string;
  let outsider: string;
  let branch: string, other: string, shift: string;
  let today: string;
  const as = (actor: string) => ({
    get: (path: string) =>
      request(app.getHttpServer()).get(path).set('x-test-actor', actor),
    post: (path: string) =>
      request(app.getHttpServer()).post(path).set('x-test-actor', actor),
  });

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
        .insertInto('coms_auth.roles')
        .values({ code, role_name: code })
        .returning('id')
        .executeTakeFirstOrThrow();
      for (const key of permissions) {
        const [module_key, action_key] = key.split('.');
        await sql`INSERT INTO coms_auth.role_permissions (role_id, permission_id)
          SELECT ${created.id}, id FROM coms_auth.permissions
          WHERE module_key = ${module_key} AND action_key = ${action_key}`.execute(
          db,
        );
      }
      return created.id;
    };
    const user = async (label: string, roleId: string) =>
      (
        await db
          .insertInto('coms_auth.users')
          .values({
            email: `${label}@report.invalid`,
            full_name: 'Report ' + label,
            contact_number: 'report-' + label,
            hashed_password: 'test-only',
            role_id: roleId,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    const superRole = (
      await db
        .selectFrom('coms_auth.roles')
        .select('id')
        .where('code', '=', 'SUPER_ADMIN')
        .executeTakeFirstOrThrow()
    ).id;
    owner = await user('owner', superRole);
    cashier = await user(
      'cashier',
      await role('REPORT_CASHIER', [
        'sales.create',
        'sales.read',
        'sales.void',
      ]),
    );
    reader = await user(
      'reader',
      await role('REPORT_READER', ['sales_report.read']),
    );
    costReader = await user(
      'cost-reader',
      await role('REPORT_COSTS', ['sales_report.read', 'costs.read']),
    );
    outsider = await user(
      'outsider',
      await role('REPORT_NONE', ['sales.read']),
    );
    const newBranch = async (code: string) =>
      (
        await db
          .insertInto('branches')
          .values({ code, branch_name: 'Report ' + code, has_dine_in: true })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    branch = await newBranch('RPT-A');
    other = await newBranch('RPT-B');
    await db
      .insertInto('coms_auth.branch_users')
      .values(
        [cashier, reader, costReader, outsider].map((user_id) => ({
          branch_id: branch,
          user_id,
        })),
      )
      .execute();
    shift = await openTestShift(db, branch, cashier);
    await db
      .insertInto('payment_methods')
      .values({ name: 'GCash', kind: 'NON_CASH' })
      .execute();

    const stock = async (
      stock_item_name: string,
      unit: string,
      cost: string,
    ) => {
      const id = (
        await db
          .insertInto('stock_items')
          .values({ stock_item_name, category: 'Report test', unit })
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
    const rice = await stock('Report rice', 'kg', '50');
    const chicken = await stock('Report chicken', 'kg', '200');
    const box = await stock('Report box', 'pcs', '6');
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
        .values({ branch_id: branch, product_id: id, price })
        .execute();
      return id;
    };
    const meal = await product('Report meal', '150');
    const drink = await product('Report drink', '50');
    await db
      .insertInto('product_ingredients')
      .values([
        { product_id: meal, stock_item_id: rice, quantity_required: '0.1' },
        { product_id: meal, stock_item_id: chicken, quantity_required: '0.25' },
        {
          product_id: meal,
          stock_item_id: box,
          quantity_required: '1',
          usage_scope: 'TAKEAWAY',
        },
      ])
      .execute();

    const sell = async (
      productId: string,
      quantity: string,
      service: 'DINE_IN' | 'TAKEAWAY',
      tender: string,
    ) => {
      const sale = await as(cashier)
        .post(`/branches/${branch}/sales`)
        .set('Idempotency-Key', randomUUID())
        .send({
          service_type: service,
          tender_method: tender,
          items: [{ product_id: productId, quantity, price_revision: 1 }],
        });
      expect(sale.status, JSON.stringify(sale.body)).toBe(201);
      return sale.body.id as string;
    };
    // Today: 300 takeout cash, 150 dine-in GCash, 50 uncosted drink, 150 voided.
    await sell(meal, '2', 'TAKEAWAY', 'Cash');
    await sell(meal, '1', 'DINE_IN', 'GCash');
    await sell(drink, '1', 'DINE_IN', 'Cash');
    const voided = await sell(meal, '1', 'DINE_IN', 'Cash');
    expect(
      (
        await as(cashier)
          .post(`/branches/${branch}/sales/${voided}/void`)
          .set('Idempotency-Key', randomUUID())
          .send({ reason: 'Wrong order' })
      ).status,
    ).toBe(201);
    // Yesterday: one 150 meal.
    const earlier = await sell(meal, '1', 'DINE_IN', 'Cash');
    await sql`UPDATE sales SET created_at = created_at - interval '1 day' WHERE id = ${earlier}::uuid`.execute(
      db,
    );
    await sql`UPDATE register_shifts SET status = 'CLOSED', closed_at = now(),
      counted_cash = 480, left_in_drawer = 0, expected_cash = 500, cash_difference = -20,
      close_type = 'CASHIER', closed_by_user_id = ${cashier}::uuid
      WHERE id = ${shift}::uuid`.execute(db);
    today = (
      await sql<{
        date: string;
      }>`SELECT coms_business_date(now())::text AS date`.execute(db)
    ).rows[0].date;
  }, 60000);

  afterAll(async () => {
    await app?.close();
    await db?.destroy();
    if (admin) {
      if (!name.startsWith('coms_report_test_')) throw Error('Unsafe cleanup');
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await admin.end();
    }
  });

  it('summarizes the day with costs and compares it with the day before', async () => {
    const response = await as(owner).get(
      `/reports/sales?period=day&date=${today}`,
    );
    expect(response.status).toBe(200);
    const report = response.body;
    expect(report.range).toEqual({ from: today, to: today });
    expect(report.scope_label).toBe('All branches');
    expect(report.headline).toEqual({
      gross_sales: '650.00',
      net_sales: '500.00',
      sales_count: 3,
      average_sale: '166.67',
      items_sold: '4',
      void_count: 1,
      void_amount: '150.00',
      food_cost: '177.00',
      gross_profit: '323.00',
      food_cost_percent: '35.4',
      cost_coverage_percent: '90',
    });
    expect(report.previous).toMatchObject({
      net_sales: '150.00',
      sales_count: 1,
    });
    expect(report.changes).toMatchObject({
      net_sales: '233.3',
      sales_count: '200',
    });
    expect(report.cash).toMatchObject({
      closed_shifts: 1,
      short_shifts: 1,
      over_shifts: 0,
      cash_difference: '-20.00',
    });
    expect(report.by_payment).toEqual([
      { name: 'Cash', sales_count: 2, amount: '350.00', share_percent: '70' },
      { name: 'GCash', sales_count: 1, amount: '150.00', share_percent: '30' },
    ]);
    expect(report.by_service).toEqual([
      {
        service_type: 'TAKEAWAY',
        sales_count: 1,
        amount: '300.00',
        share_percent: '60',
      },
      {
        service_type: 'DINE_IN',
        sales_count: 2,
        amount: '200.00',
        share_percent: '40',
      },
    ]);
    expect(
      report.top_products.map((p: { name: string; quantity: string }) => [
        p.name,
        p.quantity,
      ]),
    ).toEqual([
      ['Report meal', '3'],
      ['Report drink', '1'],
    ]);
    const branchRow = report.by_branch.find(
      (b: { branch_id: string }) => b.branch_id === branch,
    );
    expect(branchRow).toMatchObject({
      net_sales: '500.00',
      gross_profit: '323.00',
      cash_difference: '-20.00',
    });
    expect(report.daily).toEqual([]);
  });

  it('limits readers to their branches and hides costs without cost access', async () => {
    const response = await as(reader).get(
      `/reports/sales?period=day&date=${today}`,
    );
    expect(response.status).toBe(200);
    expect(response.body.show_costs).toBe(false);
    expect(response.body.scope_label).toBe('Report RPT-A');
    expect(
      response.body.branch_options.map((b: { id: string }) => b.id),
    ).toEqual([branch]);
    expect(response.body.headline).toMatchObject({
      net_sales: '500.00',
      food_cost: null,
      gross_profit: null,
    });
    expect(response.body.by_branch[0]).toMatchObject({
      food_cost: null,
      gross_profit: null,
    });
    expect(response.body.stock.waste_value).toBeNull();
    const withCosts = await as(costReader).get(
      `/reports/sales?period=day&date=${today}`,
    );
    expect(withCosts.body.headline.gross_profit).toBe('323.00');
    expect(
      (await as(reader).get(`/reports/sales?branch_id=${other}`)).status,
    ).toBe(403);
    expect((await as(outsider).get('/reports/sales')).status).toBe(403);
    expect((await as(owner).get('/reports/sales?date=2999-01-01')).status).toBe(
      400,
    );
    const week = await as(owner).get(
      `/reports/sales?period=week&date=${today}`,
    );
    expect(week.body.daily.length).toBeGreaterThan(0);
  });

  it('downloads the report as CSV and PDF and records both downloads', async () => {
    const csv = await as(owner).get(
      `/reports/sales/export?period=day&date=${today}`,
    );
    expect(csv.status).toBe(200);
    expect(csv.headers['content-disposition']).toBe(
      `attachment; filename="coms-sales-report-all-branches-${today}_${today}.csv"`,
    );
    expect(csv.text).toContain(
      'Summary,All branches,Net sales,500.00,150.00,233.3',
    );
    expect(csv.text).toContain('Payment methods,GCash,Amount,150.00');

    const pdf = await as(owner)
      .get(`/reports/sales/pdf?period=day&date=${today}&branch_id=${branch}`)
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      });
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['content-disposition']).toBe(
      `attachment; filename="coms-sales-report-rpt-a-${today}_${today}.pdf"`,
    );
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');

    const events = await db
      .selectFrom('audit_events')
      .select(['entity_label', 'branch_id', 'actor_user_id'])
      .where('action', '=', 'export.downloaded')
      .orderBy('occurred_at')
      .execute();
    expect(events).toEqual([
      { entity_label: 'Sales report', branch_id: null, actor_user_id: owner },
      {
        entity_label: 'Sales report (PDF)',
        branch_id: branch,
        actor_user_id: owner,
      },
    ]);
  });
});
