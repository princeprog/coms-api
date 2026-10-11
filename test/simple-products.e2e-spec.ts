import '../src/config/load-env';
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import {
  ValidationPipe,
  type ExecutionContext,
  type INestApplication,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { Pool } from 'pg';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  up as addPaymentMethods,
  down as removePaymentMethods,
} from '../src/database/migrations/20261012044805_payment_methods';
import { AppModule } from '../src/app.module';
import { DATABASE } from '../src/database/database.module';
import type { DB } from '../src/database/db';
import { AuthGuard } from '../src/common/guards/auth.guard';
import { AuthGatewayGuard } from '../src/common/guards/auth-gateway.guard';

describe.skipIf(process.env.COMS_RUN_DB_TESTS !== '1')(
  'simple products and financial sales',
  () => {
    const name = 'coms_simple_test_' + randomUUID().replaceAll('-', '');
    let admin: Pool, db: Kysely<DB>, app: INestApplication;
    let superAdmin: string,
      central: string,
      manager: string,
      branch: string,
      other: string,
      stock: string;
    const client = (actor = superAdmin) => ({
      post: (path: string) =>
        request(app.getHttpServer()).post(path).set('x-test-actor', actor),
      patch: (path: string) =>
        request(app.getHttpServer()).patch(path).set('x-test-actor', actor),
      put: (path: string) =>
        request(app.getHttpServer()).put(path).set('x-test-actor', actor),
      get: (path: string) =>
        request(app.getHttpServer()).get(path).set('x-test-actor', actor),
    });
    const details = (branches = [branch, other], price = '125.005') => ({
      product_name: 'Simple ' + randomUUID(),
      price,
      description: 'Shared product',
      branch_ids: branches,
      service_types: ['DINE_IN', 'TAKEAWAY'],
    });
    const create = (data = details()) => client().post('/products').send(data);
    const saleBody = (
      product: { id: string; price_revision: number },
      service_type = 'TAKEAWAY',
    ) => ({
      service_type,
      tender_method: 'CASH',
      items: [
        {
          product_id: product.id,
          quantity: '2',
          price_revision: product.price_revision,
        },
      ],
    });
    const sell = (
      product: { id: string; price_revision: number },
      key = randomUUID(),
      service = 'TAKEAWAY',
    ) =>
      client(manager)
        .post(`/branches/${branch}/sales`)
        .set('Idempotency-Key', key)
        .send(saleBody(product, service));
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
      const result = await new Migrator({
        db,
        provider: { getMigrations: async () => migrations as never },
      }).migrateToLatest();
      if (result.error) throw result.error;
      async function user(code: string, index: number) {
        const role = await db
          .selectFrom('auth.roles')
          .select('id')
          .where('code', '=', code)
          .executeTakeFirstOrThrow();
        return (
          await db
            .insertInto('auth.users')
            .values({
              role_id: role.id,
              full_name: code,
              email: code + '@simple.invalid',
              contact_number: 'simple' + index,
              hashed_password: 'test-only',
            })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;
      }
      superAdmin = await user('SUPER_ADMIN', 1);
      central = await user('COMMISSARY_MANAGER', 2);
      manager = await user('BRANCH_MANAGER', 3);
      branch = (
        await db
          .insertInto('branches')
          .values({
            code: 'SIMPLE-A',
            branch_name: 'Simple A',
            has_dine_in: true,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      other = (
        await db
          .insertInto('branches')
          .values({
            code: 'SIMPLE-B',
            branch_name: 'Simple B',
            has_dine_in: false,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      await db
        .insertInto('auth.branch_users')
        .values([
          { branch_id: branch, user_id: manager },
          { branch_id: branch, user_id: central },
        ])
        .execute();
      stock = (
        await db
          .insertInto('stock_items')
          .values({
            stock_item_name: 'Historical packaging',
            category: 'Other',
            unit: 'pcs',
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      await db
        .insertInto('branch_inventory')
        .values({
          branch_id: branch,
          stock_item_id: stock,
          quantity_on_hand: '5',
        })
        .execute();
      const module = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(DATABASE)
        .useValue(db)
        .overrideGuard(AuthGatewayGuard)
        .useValue({ canActivate: () => true })
        .overrideGuard(AuthGuard)
        .useValue({
          canActivate: (ctx: ExecutionContext) => {
            const req = ctx.switchToHttp().getRequest();
            req.user = { id: req.headers['x-test-actor'] ?? superAdmin };
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
    }, 30000);
    afterAll(async () => {
      await app?.close();
      await db?.destroy();
      if (admin) {
        if (!name.startsWith('coms_simple_test_'))
          throw Error('Unsafe cleanup');
        await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
        await admin.end();
      }
    });
    it('requires an exact selling price immediately on every creation path', async () => {
      const { price: _price, ...withoutPrice } = details();
      expect(
        (await create(withoutPrice as ReturnType<typeof details>)).status,
      ).toBe(400);
      expect(
        (
          await client()
            .post('/products/setup')
            .set('Idempotency-Key', randomUUID())
            .send({ product: withoutPrice, expected_product_revision: 0 })
        ).status,
      ).toBe(400);
      for (const price of ['-1', 'NaN', '1e2', ''])
        expect((await create(details([], price))).status).toBe(400);
    });
    it('saves one exact price and availability across branches atomically', async () => {
      const result = await create();
      expect(result.status).toBe(201);
      expect(result.body.price).toBe('125.005');
      expect(result.body.price_revision).toBe(1);
      for (const id of [branch, other]) {
        const menu = await client().get(
          `/branches/${id}/products/${result.body.id}`,
        );
        expect(menu.status).toBe(200);
        expect(menu.body.price).toBe('125.005');
        expect(menu.body.is_available).toBe(true);
        expect(menu.body.available_service_types).toEqual(
          id === branch ? ['DINE_IN', 'TAKEAWAY'] : ['TAKEAWAY'],
        );
      }
      expect(
        await db
          .selectFrom('product_ingredients')
          .selectAll()
          .where('product_id', '=', result.body.id)
          .execute(),
      ).toEqual([]);
    });
    it('starts with no branches and rejects invalid selection without partial creation', async () => {
      const empty = await create(details([]));
      expect(empty.status).toBe(201);
      expect(
        await db
          .selectFrom('branch_products')
          .selectAll()
          .where('product_id', '=', empty.body.id)
          .execute(),
      ).toEqual([]);
      const bad = details([randomUUID()]);
      expect((await create(bad)).status).toBe(404);
      expect(
        await db
          .selectFrom('products')
          .selectAll()
          .where('product_name', '=', bad.product_name)
          .execute(),
      ).toEqual([]);
      const unsupported = { ...details([other]), service_types: ['DINE_IN'] };
      expect((await create(unsupported)).status).toBe(409);
    });
    it('requires protected Super Admin despite old central grants and forged custom admin names', async () => {
      for (const actor of [central, manager])
        expect(
          (await client(actor).post('/products').send(details())).status,
        ).toBe(403);
      const product = (await create()).body;
      for (const actor of [central, manager]) {
        expect(
          (
            await client(actor).patch(`/products/${product.id}`).send({
              price: '1',
              expected_product_revision: product.setup_revision,
            })
          ).status,
        ).toBe(403);
        expect(
          (await client(actor).post(`/products/${product.id}/deactivate`))
            .status,
        ).toBe(403);
        expect(
          (
            await client(actor)
              .post(`/branches/${branch}/products/${product.id}/availability`)
              .send({ is_available: false })
          ).status,
        ).toBe(403);
        expect(
          (
            await client(actor)
              .patch(`/branches/${branch}/products/${product.id}/services`)
              .send({ service_types: ['TAKEAWAY'] })
          ).status,
        ).toBe(403);
      }
    });
    it('disables deselected offerings without deleting history and mirrors global price updates', async () => {
      const product = (await create()).body;
      const updated = await client()
        .patch(`/products/${product.id}`)
        .send({
          branch_ids: [branch],
          price: '130.123456789',
          expected_product_revision: product.setup_revision,
        });
      expect(updated.status).toBe(200);
      expect(updated.body.price_revision).toBe(2);
      const rows = await db
        .selectFrom('branch_products')
        .selectAll()
        .where('product_id', '=', product.id)
        .orderBy('branch_id')
        .execute();
      expect(rows).toHaveLength(2);
      expect(rows.find((r) => r.branch_id === other)?.is_available).toBe(false);
      expect(rows.every((r) => r.price === '130.123456789')).toBe(true);
      expect(
        (
          await client().patch(`/products/${product.id}`).send({
            price: '1',
            expected_product_revision: product.setup_revision,
          })
        ).status,
      ).toBe(409);
    });
    it('keeps menu reads branch scoped and removes retired active interfaces', async () => {
      expect(
        (await client(manager).get(`/branches/${other}/products`)).status,
      ).toBe(403);
      expect(
        (await client(manager).get(`/branches/${branch}/products`)).status,
      ).toBe(200);
      const product = (await create()).body;
      for (const path of [
        '/menu-requests',
        '/menu-templates',
        `/branches/${branch}/product-prices`,
        `/products/${product.id}/recipe`,
      ])
        expect((await client().get(path)).status).toBe(404);
      expect(
        (
          await client()
            .patch(`/branches/${branch}/products/${product.id}`)
            .send({ price: '5', expected_revision: 1 })
        ).status,
      ).toBe(404);
      expect(
        (
          await client().post('/stock-items').send({
            stock_item_name: 'Plain stock',
            category: 'Other',
            unit: 'pcs',
          })
        ).status,
      ).toBe(201);
      expect(
        (await client().get('/stock-items?usage_type=INGREDIENT')).status,
      ).toBe(400);
    });
    it('sells without recipes, balances or ingredient validation and never writes consumption', async () => {
      const product = (await create()).body;
      const before = await db
        .selectFrom('branch_inventory')
        .selectAll()
        .execute();
      const result = await sell(product);
      expect(result.status).toBe(201);
      expect(result.body.total_amount).toBe('250.01');
      expect(result.body.inventory_deducted).toBe(false);
      expect(
        await db.selectFrom('branch_inventory').selectAll().execute(),
      ).toEqual(before);
      expect(
        await db.selectFrom('sale_item_consumptions').selectAll().execute(),
      ).toEqual([]);
      expect(
        await db.selectFrom('inventory_movements').selectAll().execute(),
      ).toEqual([]);
      const key = randomUUID();
      const voided = await client(manager)
        .post(`/branches/${branch}/sales/${result.body.id}/void`)
        .set('Idempotency-Key', key)
        .send({ reason: 'Customer cancelled' });
      expect(voided.status).toBe(201);
      expect(voided.body.status).toBe('VOIDED');
      expect(
        await db.selectFrom('branch_inventory').selectAll().execute(),
      ).toEqual(before);
      expect(
        await db.selectFrom('inventory_movements').selectAll().execute(),
      ).toEqual([]);
      expect(
        (
          await client(manager)
            .post(`/branches/${branch}/sales/${result.body.id}/void`)
            .set('Idempotency-Key', key)
            .send({ reason: 'Customer cancelled' })
        ).body.id,
      ).toBe(result.body.id);
    });
    it('rejects forged prices and unsupported services and unavailable products', async () => {
      const product = (await create()).body;
      expect(
        (
          await client(manager)
            .post(`/branches/${branch}/sales`)
            .set('Idempotency-Key', randomUUID())
            .send({
              ...saleBody(product),
              items: [{ ...saleBody(product).items[0], unit_price: '0.01' }],
            })
        ).status,
      ).toBe(400);
      expect(
        (
          await client()
            .post(`/branches/${branch}/products`)
            .send({
              product_id: product.id,
              price: '1',
              service_types: ['TAKEAWAY'],
            })
        ).status,
      ).toBe(400);
      expect(
        (
          await client(manager)
            .post(`/branches/${other}/sales`)
            .set('Idempotency-Key', randomUUID())
            .send(saleBody(product, 'DINE_IN'))
        ).status,
      ).toBe(403);
      await client()
        .post(`/branches/${branch}/products/${product.id}/availability`)
        .send({ is_available: false });
      expect((await sell(product)).status).toBe(409);
    });
    it('returns successful retries after price changes and requires review of stale uncommitted sales', async () => {
      const product = (await create()).body,
        key = randomUUID();
      const original = await sell(product, key);
      expect(original.status).toBe(201);
      const updated = await client().patch(`/products/${product.id}`).send({
        price: '130',
        expected_product_revision: product.setup_revision,
      });
      expect(updated.status).toBe(200);
      const retry = await sell(product, key);
      expect(retry.status).toBe(201);
      expect(retry.body).toEqual(original.body);
      const conflict = await sell(product);
      expect(conflict.status).toBe(409);
      expect(conflict.body.code).toBe('PRICE_CHANGED');
      const refreshed = await sell(updated.body);
      expect(refreshed.status).toBe(201);
      expect(refreshed.body.total_amount).toBe('260');
    });
    it('retains atomic setup saves and actor-bound successful retries', async () => {
      const data = { product: details(), expected_product_revision: 0 },
        key = randomUUID();
      const result = await client()
        .post('/products/setup')
        .set('Idempotency-Key', key)
        .send(data);
      expect(result.status).toBe(201);
      expect(result.body.product.price).toBe('125.005');
      const retry = await client()
        .post('/products/setup')
        .set('Idempotency-Key', key)
        .send(data);
      expect(retry.body).toEqual(result.body);
      expect(
        (
          await client()
            .post('/products/setup')
            .set('Idempotency-Key', key)
            .send({ ...data, product: { ...data.product, price: '1' } })
        ).status,
      ).toBe(409);
    });
    async function historical(withMovement: boolean) {
      const product = (await create()).body;
      const sale = (
        await sql<{
          id: string;
        }>`INSERT INTO sales(branch_id,cashier_user_id,status,tender_method,total_amount,idempotency_key,inventory_deducted) VALUES(${branch}::uuid,${manager}::uuid,'COMPLETED','CASH',10,${randomUUID()}::uuid,true) RETURNING id`.execute(
          db,
        )
      ).rows[0];
      const item = (
        await sql<{
          id: string;
        }>`INSERT INTO sale_items(sale_id,product_id,product_name_snapshot,quantity,unit_price,line_total) VALUES(${sale.id}::uuid,${product.id}::uuid,'Historical product',1,10,10) RETURNING id`.execute(
          db,
        )
      ).rows[0];
      const consumption = (
        await sql<{
          id: string;
        }>`INSERT INTO sale_item_consumptions(sale_item_id,stock_item_id,quantity_consumed) VALUES(${item.id}::uuid,${stock}::uuid,1.25) RETURNING id`.execute(
          db,
        )
      ).rows[0];
      if (withMovement)
        await sql`INSERT INTO inventory_movements(inventory_scope,branch_id,stock_item_id,movement_type,quantity_delta,actor_user_id,sale_item_consumption_id) VALUES('BRANCH',${branch}::uuid,${stock}::uuid,'SALE',-1.25,${manager}::uuid,${consumption.id}::uuid)`.execute(
          db,
        );
      return sale.id;
    }
    it('reverses historical saved deductions independently of retired recipe changes', async () => {
      const id = await historical(true);
      const result = await client(manager)
        .post(`/branches/${branch}/sales/${id}/void`)
        .set('Idempotency-Key', randomUUID())
        .send({ reason: 'Historical correction' });
      expect(result.status).toBe(201);
      expect(result.body.inventory_deducted).toBe(true);
      expect(
        (
          await db
            .selectFrom('branch_inventory')
            .select('quantity_on_hand')
            .where('stock_item_id', '=', stock)
            .executeTakeFirstOrThrow()
        ).quantity_on_hand,
      ).toBe('6.25');
      const reversals = await db
        .selectFrom('inventory_movements')
        .selectAll()
        .where('movement_type', '=', 'SALE_VOID')
        .execute();
      expect(reversals).toHaveLength(1);
      expect(reversals[0].quantity_delta).toBe('1.25');
    });
    it('rejects historical voids with missing movement history without partial changes', async () => {
      const id = await historical(false),
        before = await db.selectFrom('branch_inventory').selectAll().execute();
      expect(
        (
          await client(manager)
            .post(`/branches/${branch}/sales/${id}/void`)
            .set('Idempotency-Key', randomUUID())
            .send({ reason: 'Missing history' })
        ).status,
      ).toBe(500);
      expect(
        (
          await db
            .selectFrom('sales')
            .select('status')
            .where('id', '=', id)
            .executeTakeFirstOrThrow()
        ).status,
      ).toBe('COMPLETED');
      expect(
        await db.selectFrom('branch_inventory').selectAll().execute(),
      ).toEqual(before);
    });
    it.each(['quantity', 'stock item'])(
      'rejects historical voids whose saved movement disagrees with the consumption %s',
      async (mismatch) => {
        const id = await historical(true);
        const movement = await db
          .selectFrom('inventory_movements as im')
          .innerJoin(
            'sale_item_consumptions as sic',
            'sic.id',
            'im.sale_item_consumption_id',
          )
          .innerJoin('sale_items as si', 'si.id', 'sic.sale_item_id')
          .select('im.id')
          .where('si.sale_id', '=', id)
          .executeTakeFirstOrThrow();
        if (mismatch === 'quantity') {
          await db
            .updateTable('inventory_movements')
            .set({ quantity_delta: '-2' })
            .where('id', '=', movement.id)
            .execute();
        } else {
          const wrongStock = await db
            .insertInto('stock_items')
            .values({
              stock_item_name: 'Unrelated stock',
              unit: 'pcs',
              category: 'Other',
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          await db
            .insertInto('branch_inventory')
            .values({
              branch_id: branch,
              stock_item_id: wrongStock.id,
              quantity_on_hand: '5',
            })
            .execute();
          await db
            .updateTable('inventory_movements')
            .set({ stock_item_id: wrongStock.id })
            .where('id', '=', movement.id)
            .execute();
        }
        const balances = await db
          .selectFrom('branch_inventory')
          .selectAll()
          .orderBy('stock_item_id')
          .execute();
        const result = await client(manager)
          .post(`/branches/${branch}/sales/${id}/void`)
          .set('Idempotency-Key', randomUUID())
          .send({ reason: 'Invalid history' });
        expect(result.status).toBe(500);
        expect(
          await db
            .selectFrom('branch_inventory')
            .selectAll()
            .orderBy('stock_item_id')
            .execute(),
        ).toEqual(balances);
        expect(
          (
            await db
              .selectFrom('sales')
              .select('status')
              .where('id', '=', id)
              .executeTakeFirstOrThrow()
          ).status,
        ).toBe('COMPLETED');
        expect(
          await db
            .selectFrom('sale_events')
            .select('id')
            .where('sale_id', '=', id)
            .execute(),
        ).toHaveLength(0);
      },
    );
    it('rejects historical voids when an entire sale line has lost its consumption history', async () => {
      const id = await historical(true);
      const product = (await create(details([]))).body;
      await db
        .insertInto('sale_items')
        .values({
          sale_id: id,
          product_id: product.id,
          product_name_snapshot: 'Missing consumption history',
          quantity: '1',
          unit_price: '0',
          line_total: '0',
        })
        .execute();
      const balances = await db
        .selectFrom('branch_inventory')
        .selectAll()
        .orderBy('stock_item_id')
        .execute();
      const result = await client(manager)
        .post(`/branches/${branch}/sales/${id}/void`)
        .set('Idempotency-Key', randomUUID())
        .send({ reason: 'Incomplete history' });
      expect(result.status).toBe(500);
      expect(
        await db
          .selectFrom('branch_inventory')
          .selectAll()
          .orderBy('stock_item_id')
          .execute(),
      ).toEqual(balances);
      expect(
        (
          await db
            .selectFrom('sales')
            .select('status')
            .where('id', '=', id)
            .executeTakeFirstOrThrow()
        ).status,
      ).toBe('COMPLETED');
    });

    it('restricts payment-method management to protected Super Admin', async () => {
      const input = { name: 'Card', kind: 'NON_CASH', is_active: true };
      const cash = (await client().get('/payment-methods')).body.items[0];
      for (const actor of [central, manager]) {
        expect((await client(actor).get('/payment-methods')).status).toBe(403);
        expect(
          (await client(actor).post('/payment-methods').send(input)).status,
        ).toBe(403);
        expect(
          (await client(actor).patch(`/payment-methods/${cash.id}`).send(input))
            .status,
        ).toBe(403);
        expect(
          (await client(actor).post(`/payment-methods/${cash.id}/deactivate`))
            .status,
        ).toBe(403);
      }
      expect(
        (await client(manager).get('/payment-methods/available')).body,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'Cash', kind: 'CASH' }),
        ]),
      );
    });

    it('validates names and supports create, edit, deactivate, reactivate and filtered pagination', async () => {
      const input = {
        name: '  Mobile wallet  ',
        kind: 'NON_CASH',
        is_active: true,
      };
      const created = await client().post('/payment-methods').send(input);
      expect(created.status).toBe(201);
      expect(created.body.name).toBe('Mobile wallet');
      expect(
        (
          await client()
            .post('/payment-methods')
            .send({ ...input, name: 'mobile WALLET' })
        ).status,
      ).toBe(409);
      for (const patch of [
        { name: ' ' },
        { kind: 'INVALID' },
        { is_active: 'true' },
        { price: '1' },
      ]) {
        expect(
          (
            await client()
              .post('/payment-methods')
              .send({ ...input, ...patch })
          ).status,
        ).toBe(400);
      }
      const id = created.body.id;
      expect(
        (
          await client()
            .patch(`/payment-methods/${id}`)
            .send({ ...input, name: 'Wallet' })
        ).body.name,
      ).toBe('Wallet');
      expect(
        (await client().post(`/payment-methods/${id}/deactivate`)).status,
      ).toBe(201);
      expect(
        (await client(manager).get('/payment-methods/available')).body.some(
          (item: { id: string }) => item.id === id,
        ),
      ).toBe(false);
      const filtered = await client().get(
        '/payment-methods?search=wallet&is_active=false&page_size=1',
      );
      expect(filtered.body.total).toBe(1);
      expect(filtered.body.items[0].id).toBe(id);
      expect(
        (
          await client()
            .patch(`/payment-methods/${id}`)
            .send({ ...input, name: 'Wallet' })
        ).body.is_active,
      ).toBe(true);
    });

    it('uses the authoritative name and preserves a successful retry after renaming and disabling', async () => {
      const method = (
        await client()
          .post('/payment-methods')
          .send({ name: 'Debit card', kind: 'NON_CASH', is_active: true })
      ).body;
      const product = (await create()).body;
      const key = randomUUID();
      const input = {
        ...saleBody(product),
        payment_method_id: method.id,
        tender_method: 'Forged name',
      };
      const post = () =>
        client(manager)
          .post(`/branches/${branch}/sales`)
          .set('Idempotency-Key', key)
          .send(input);
      const first = await post();
      expect(first.status).toBe(201);
      expect(first.body.tender_method).toBe('Debit card');
      expect(first.body.payment_method_id).toBe(method.id);
      await client()
        .patch(`/payment-methods/${method.id}`)
        .send({ name: 'Renamed card', kind: 'NON_CASH', is_active: false });
      const retry = await post();
      expect(retry.status).toBe(201);
      expect(retry.body.id).toBe(first.body.id);
      expect(retry.body.tender_method).toBe('Debit card');
      const rejected = await client(manager)
        .post(`/branches/${branch}/sales`)
        .set('Idempotency-Key', randomUUID())
        .send(input);
      expect(rejected.status).toBe(409);
      expect(rejected.body.code).toBe('PAYMENT_METHOD_UNAVAILABLE');
      const different = await client(manager)
        .post(`/branches/${branch}/sales`)
        .set('Idempotency-Key', key)
        .send({ ...input, payment_method_id: randomUUID() });
      expect(different.status).toBe(409);
    });

    it('rejects unknown payment methods without writing a sale and accepts legacy Cash clients', async () => {
      const product = (await create()).body;
      for (const method of [
        { payment_method_id: randomUUID() },
        { tender_method: 'Unconfigured tender' },
      ]) {
        const key = randomUUID();
        const result = await client(manager)
          .post(`/branches/${branch}/sales`)
          .set('Idempotency-Key', key)
          .send({ ...saleBody(product), ...method });
        expect(result.status).toBe(409);
        expect(result.body.code).toBe('PAYMENT_METHOD_UNAVAILABLE');
        expect(
          await db
            .selectFrom('sales')
            .select('id')
            .where('idempotency_key', '=', key)
            .execute(),
        ).toEqual([]);
      }
      expect((await sell(product)).status).toBe(201);
    });

    it('upgrades legacy tender snapshots and safely rolls back an unused configuration', async () => {
      await db.transaction().execute(async (trx) => {
        const schema = 'payment_migration_' + randomUUID().replaceAll('-', '');
        await sql.raw(`CREATE SCHEMA "${schema}"`).execute(trx);
        await sql
          .raw(`SET LOCAL search_path TO "${schema}", public`)
          .execute(trx);
        await sql`CREATE TABLE sales (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tender_method text NOT NULL)`.execute(
          trx,
        );
        await sql`INSERT INTO sales(tender_method) VALUES ('Historical wallet')`.execute(
          trx,
        );
        await addPaymentMethods(trx);
        const upgraded = await sql<{
          tender_method: string;
          payment_method_id: string | null;
        }>`SELECT tender_method, payment_method_id FROM sales`.execute(trx);
        expect(upgraded.rows).toEqual([
          { tender_method: 'Historical wallet', payment_method_id: null },
        ]);
        await removePaymentMethods(trx);
        expect(
          (
            await sql<{
              tender_method: string;
            }>`SELECT tender_method FROM sales`.execute(trx)
          ).rows,
        ).toEqual([{ tender_method: 'Historical wallet' }]);
        await sql.raw(`DROP SCHEMA "${schema}" CASCADE`).execute(trx);
      });
    });

    it('refuses rollback when configured payment history would be lost', async () => {
      await expect(
        db.transaction().execute((trx) => removePaymentMethods(trx)),
      ).rejects.toThrow('Payment methods are in use');
      expect((await client().get('/payment-methods')).status).toBe(200);
    });
  },
);
