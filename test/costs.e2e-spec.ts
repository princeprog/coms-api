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
  'stock costing and profit snapshots',
  () => {
    // Its own database so other suites never see these sales.
    const name = 'coms_costs_test_' + randomUUID().replaceAll('-', '');
    let admin: Pool;
    let app: INestApplication;
    let db: Kysely<DB>;
    let cashier: string, reader: string, manager: string;
    let branch: string;
    let rice: string, chicken: string, box: string;
    let meal: string;
    const as = (actor: string) => ({
      get: (path: string) =>
        request(app.getHttpServer()).get(path).set('x-test-actor', actor),
      post: (path: string) =>
        request(app.getHttpServer()).post(path).set('x-test-actor', actor),
    });
    const setCost = (stockItemId: string, unitCost: string) =>
      db
        .insertInto('stock_item_costs')
        .values({
          stock_item_id: stockItemId,
          average_unit_cost: unitCost,
          cost_source: 'MANUAL',
          updated_by_user_id: manager,
        })
        .onConflict((c) =>
          c
            .column('stock_item_id')
            .doUpdateSet({ average_unit_cost: unitCost }),
        )
        .execute();

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
        await role('COST_READER', ['costs.read', 'sales_report.read']),
      );
      manager = await user('cost-manager', await role('COST_MANAGER', []));
      const newBranch = async (code: string) =>
        (
          await db
            .insertInto('branches')
            .values({ code, branch_name: 'Cost ' + code, has_dine_in: true })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;
      branch = await newBranch('COST-A');
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

    it('snapshots costs on sales and reports profit without voided sales', async () => {
      // Rice keeps the ₱40 receipt average from the previous test.
      await setCost(chicken, '200');
      await setCost(box, '6');
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
      await setCost(chicken, '999');

      const { rows } = await sql<{ today: string }>`
        SELECT coms_business_date(now())::text AS today`.execute(db);
      const report = await as(reader).get(
        `/reports/sales?period=day&date=${rows[0].today}&branch_id=${branch}`,
      );
      expect(report.status, JSON.stringify(report.body)).toBe(200);
      expect(report.body.show_costs).toBe(true);
      const headline = report.body.headline;
      // Takeout 2 × (0.1 × 40 + 0.25 × 200 + 6) + Dine-in 2 × (4 + 50).
      expect(Number(headline.net_sales)).toBe(600);
      expect(Number(headline.food_cost)).toBe(228);
      expect(Number(headline.gross_profit)).toBe(372);
      expect(Number(headline.cost_coverage_percent)).toBe(100);
    });
  },
);
