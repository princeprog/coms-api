import '../src/config/load-env';
import {
  ValidationPipe,
  type ExecutionContext,
  type INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { AuthGatewayGuard } from '../src/common/guards/auth-gateway.guard';
import { AuthGuard } from '../src/common/guards/auth.guard';
import { DATABASE } from '../src/database/database.module';
import type { DB } from '../src/database/db';
import { applyReceiptCost } from '../src/modules/costs/stock-costs';
import { testProductCategoryId } from './product-category-fixture';
import { openTestShift } from './shift-fixture';

// Runs only in a disposable database (scripts/test-disposable-db.cjs).
describe.skipIf(process.env.COMS_RUN_DB_TESTS !== '1')(
  'costs and profit',
  () => {
    // Its own database so other suites never see these sales.
    const name = 'coms_costs_test_' + randomUUID().replaceAll('-', '');
    let admin: Pool;
    let app: INestApplication;
    let db: Kysely<DB>;
    let cashier: string, reader: string, globalReader: string, manager: string;
    let branch: string, other: string;
    let rice: string, chicken: string, box: string;
    let meal: string;
    const as = (actor: string) => ({
      get: (path: string) =>
        request(app.getHttpServer()).get(path).set('x-test-actor', actor),
      post: (path: string) =>
        request(app.getHttpServer()).post(path).set('x-test-actor', actor),
      put: (path: string) =>
        request(app.getHttpServer()).put(path).set('x-test-actor', actor),
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
      db = new Kysely<DB>({
        dialect: new PostgresDialect({
          pool: new Pool({ connectionString: url.toString() }),
        }),
      });
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
              email: `${label}@costs.invalid`,
              full_name: label,
              contact_number: label,
              hashed_password: 'test-only',
              role_id: roleId,
            })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;
      cashier = await user(
        'cost-cashier',
        await role('COST_CASHIER', [
          'sales.create',
          'sales.read',
          'sales.void',
        ]),
      );
      reader = await user(
        'cost-reader',
        await role('COST_READER', ['costs.read']),
      );
      globalReader = await user(
        'cost-global',
        await role('COST_GLOBAL', ['costs.read', 'costs.global_read']),
      );
      manager = await user(
        'cost-manager',
        await role('COST_MANAGER', ['costs.read', 'costs.manage']),
      );
      const newBranch = async (code: string) =>
        (
          await db
            .insertInto('branches')
            .values({ code, branch_name: 'Cost ' + code, has_dine_in: true })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;
      branch = await newBranch('COST-A');
      other = await newBranch('COST-B');
      await db
        .insertInto('coms_auth.branch_users')
        .values([
          { branch_id: branch, user_id: cashier },
          { branch_id: branch, user_id: reader },
        ])
        .execute();
      await openTestShift(db, branch, cashier);

      const stock = async (name: string, unit: string) =>
        (
          await db
            .insertInto('stock_items')
            .values({ stock_item_name: name, category: 'Cost test', unit })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;
      rice = await stock('Cost rice', 'kg');
      chicken = await stock('Cost chicken', 'kg');
      box = await stock('Cost box', 'pcs');
      await stock('Cost sauce', 'L');
      meal = (
        await db
          .insertInto('products')
          .values({
            product_name: 'Cost meal',
            price: '150',
            category_id: testProductCategoryId,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      await db
        .insertInto('branch_products')
        .values({ branch_id: branch, product_id: meal, price: '150' })
        .execute();
      await db
        .insertInto('product_ingredients')
        .values([
          { product_id: meal, stock_item_id: rice, quantity_required: '0.1' },
          {
            product_id: meal,
            stock_item_id: chicken,
            quantity_required: '0.25',
          },
          {
            product_id: meal,
            stock_item_id: box,
            quantity_required: '1',
            usage_scope: 'TAKEAWAY',
          },
        ])
        .execute();
    }, 30000);

    afterAll(async () => {
      await app?.close();
      await db?.destroy();
      if (admin) {
        if (!name.startsWith('coms_costs_test_')) throw Error('Unsafe cleanup');
        await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
        await admin.end();
      }
    });

    it('averages receipt costs against commissary stock already on hand', async () => {
      await db
        .insertInto('commissary_inventory')
        .values({ stock_item_id: rice, quantity_on_hand: '10' })
        .execute();
      const receive = (quantity: string, unitCost: string) =>
        db.transaction().execute((tx) =>
          applyReceiptCost(tx, {
            stockItemId: rice,
            quantity,
            unitCost,
            receivedAt: '2026-10-01',
            actorUserId: manager,
          }),
        );
      await receive('10', '50'); // first cost: becomes the average
      await db
        .updateTable('commissary_inventory')
        .set({ quantity_on_hand: '10' })
        .where('stock_item_id', '=', rice)
        .execute();
      await receive('30', '60'); // (10 × 50 + 30 × 60) / 40 = 57.5
      const cost = await db
        .selectFrom('stock_item_costs')
        .select(['average_unit_cost', 'last_unit_cost', 'cost_source'])
        .where('stock_item_id', '=', rice)
        .executeTakeFirstOrThrow();
      expect(Number(cost.average_unit_cost)).toBe(57.5);
      expect(Number(cost.last_unit_cost)).toBe(60);
      await db
        .updateTable('commissary_inventory')
        .set({ quantity_on_hand: '0' })
        .where('stock_item_id', '=', rice)
        .execute();
      await receive('10', '40'); // nothing on hand: the new cost replaces the average
      expect(
        Number(
          (
            await db
              .selectFrom('stock_item_costs')
              .select('average_unit_cost')
              .where('stock_item_id', '=', rice)
              .executeTakeFirstOrThrow()
          ).average_unit_cost,
        ),
      ).toBe(40);
    });

    it('prices recipes per service and flags missing costs', async () => {
      expect(
        (
          await as(manager)
            .put(`/costs/stock-items/${chicken}`)
            .send({ unit_cost: '200', reason: 'Market price' })
        ).status,
      ).toBe(200);
      expect(
        (
          await as(reader)
            .put(`/costs/stock-items/${box}`)
            .send({ unit_cost: '5', reason: 'No permission' })
        ).status,
      ).toBe(403);
      const missing = await as(reader).get(
        '/costs/products?status=incomplete&search=Cost meal',
      );
      expect(missing.body.items[0]).toMatchObject({
        product_id: meal,
        dine_in_cost: '54',
        missing_cost_items: ['Cost box'],
      });
      await as(manager)
        .put(`/costs/stock-items/${box}`)
        .send({ unit_cost: '6', reason: 'Supplier quote' });
      const priced = await as(reader).get('/costs/products?search=Cost meal');
      expect(priced.body.items[0]).toMatchObject({
        dine_in_cost: '54',
        takeout_cost: '60',
        dine_in_margin: '96',
        takeout_margin: '90',
        lowest_margin_percent: '60',
        missing_cost_items: [],
      });
      const incomplete = await as(reader).get(
        '/costs/products?status=incomplete&search=Cost meal',
      );
      expect(incomplete.body.items).toEqual([]);
      const stock = await as(reader).get(
        '/costs/stock-items?search=Cost&missing_only=true',
      );
      expect(
        stock.body.items.map(
          (i: { stock_item_name: string }) => i.stock_item_name,
        ),
      ).toEqual(['Cost sauce']);
    });

    it('snapshots costs on sales and reports profit without voided sales', async () => {
      const sell = (service: string) =>
        as(cashier)
          .post(`/branches/${branch}/sales`)
          .set('Idempotency-Key', randomUUID())
          .send({
            service_type: service,
            tender_method: 'Cash',
            items: [{ product_id: meal, quantity: '2', price_revision: 1 }],
          });
      const takeout = await sell('TAKEAWAY');
      const dineIn = await sell('DINE_IN');
      const voided = await sell('DINE_IN');
      expect([takeout.status, dineIn.status, voided.status]).toEqual([
        201, 201, 201,
      ]);
      expect(
        (
          await as(cashier)
            .post(`/branches/${branch}/sales/${voided.body.id}/void`)
            .set('Idempotency-Key', randomUUID())
            .send({ reason: 'Wrong order' })
        ).status,
      ).toBe(201);
      // Later cost changes never rewrite recorded profit.
      await as(manager)
        .put(`/costs/stock-items/${chicken}`)
        .send({ unit_cost: '999', reason: 'Price spike' });

      const profit = await as(reader).get('/costs/branches');
      expect(profit.status).toBe(200);
      expect(profit.body.branches).toHaveLength(1);
      expect(profit.body.branches[0]).toMatchObject({
        branch_id: branch,
        sales_count: 2,
        net_sales: '600',
        food_cost: '228',
        gross_profit: '372',
        food_cost_percent: '38',
        cost_coverage_percent: '100',
      });
      const products = await as(reader).get('/costs/branch-products');
      expect(products.body.items[0]).toMatchObject({
        product_id: meal,
        units_sold: '4',
        net_sales: '600',
        food_cost: '228',
        fully_costed: true,
      });
    });

    it('limits branch scope to assigned branches unless global', async () => {
      // Approved counts are valued at their snapshotted cost.
      const report = await db
        .insertInto('daily_branch_reports')
        .values({
          branch_id: branch,
          business_date: sql<Date>`coms_business_date(now())`,
          status: 'APPROVED',
          idempotency_key: randomUUID(),
          created_by_user_id: cashier,
          submitted_by_user_id: cashier,
          submitted_at: sql<Date>`now()`,
          reviewed_by_user_id: globalReader,
          reviewed_at: sql<Date>`now()`,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await db
        .insertInto('daily_branch_report_items')
        .values({
          daily_branch_report_id: report.id,
          stock_item_id: chicken,
          opening_quantity: '5',
          receipt_quantity: '0',
          sale_consumption_quantity: '0',
          sale_void_reversal_quantity: '0',
          ledger_adjustment_quantity: '0',
          ledger_closing_quantity: '5',
          waste_quantity: '0.5',
          waste_reason: 'Spoiled',
          expected_closing_quantity: '4.5',
          physical_closing_quantity: '4.25',
          variance_quantity: '-0.25',
          unit_cost: '200',
        })
        .execute();
      const valued = await as(reader).get('/costs/branches');
      expect(valued.body.branches[0]).toMatchObject({
        waste_value: '100',
        variance_value: '-50',
      });

      expect(
        (await as(reader).get(`/costs/branches?branch_id=${other}`)).status,
      ).toBe(403);
      const global = await as(globalReader).get('/costs/branches');
      const ids = global.body.branches.map(
        (b: { branch_id: string }) => b.branch_id,
      );
      expect(ids).toEqual(expect.arrayContaining([branch, other]));
      expect(
        (await as(reader).get('/costs/branches?from=2026-01-01&to=2027-06-01'))
          .status,
      ).toBe(400);
    });
  },
);
