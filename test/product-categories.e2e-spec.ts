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
import { AppModule } from '../src/app.module';
import { DATABASE } from '../src/database/database.module';
import type { DB } from '../src/database/db';
import { AuthGuard } from '../src/common/guards/auth.guard';
import { AuthGatewayGuard } from '../src/common/guards/auth-gateway.guard';
import {
  up,
  down,
  categoryProductNames,
} from '../src/database/migrations/20261019235124_product_categories';

describe.skipIf(process.env.COMS_RUN_DB_TESTS !== '1')(
  'product categories',
  () => {
    const name = 'coms_categories_test_' + randomUUID().replaceAll('-', '');
    let admin: Pool, db: Kysely<DB>, app: INestApplication;
    let superAdmin: string,
      manager: string,
      central: string,
      noAccess: string,
      branch: string,
      other: string,
      categoryId: string;
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
    const details = (category = categoryId) => ({
      product_name: 'Category meal ' + randomUUID(),
      category_id: category,
      price: '125.005',
      branch_ids: [branch],
      service_types: ['DINE_IN', 'TAKEAWAY'],
    });
    async function category() {
      const result = await client()
        .post('/product-categories')
        .send({ name: 'Category ' + randomUUID() });
      expect(result.status).toBe(201);
      return result.body as { id: string; name: string };
    }
    async function product(category = categoryId) {
      const result = await client().post('/products').send(details(category));
      expect(result.status).toBe(201);
      return result.body as {
        id: string;
        setup_revision: number;
        price_revision: number;
        category_id: string;
      };
    }
    beforeAll(async () => {
      const url = new URL(
        process.env.COMS_TEST_ADMIN_URL ?? process.env.DATABASE_URL!,
      );
      if (!['localhost', '127.0.0.1'].includes(url.hostname))
        throw Error('Use a verified loopback target');
      url.pathname = '/postgres';
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
      categoryId = (
        await db
          .selectFrom('product_categories')
          .select('id')
          .where('name', '=', 'Rice meals')
          .executeTakeFirstOrThrow()
      ).id;
      async function user(code: string | null) {
        const role = code
          ? await db
              .selectFrom('auth.roles')
              .select('id')
              .where('code', '=', code)
              .executeTakeFirstOrThrow()
          : null;
        return (
          await db
            .insertInto('auth.users')
            .values({
              role_id: role?.id ?? null,
              full_name: code ?? 'Unassigned',
              email: randomUUID() + '@categories.invalid',
              contact_number: randomUUID().slice(0, 24),
              hashed_password: 'test-only',
            })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;
      }
      superAdmin = await user('SUPER_ADMIN');
      manager = await user('BRANCH_MANAGER');
      central = await user('COMMISSARY_MANAGER');
      noAccess = await user(null);
      branch = (
        await db
          .insertInto('branches')
          .values({
            code: 'CATEGORY-A',
            branch_name: 'Category A',
            has_dine_in: true,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      other = (
        await db
          .insertInto('branches')
          .values({
            code: 'CATEGORY-B',
            branch_name: 'Category B',
            has_dine_in: false,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      await db
        .insertInto('auth.branch_users')
        .values({ branch_id: branch, user_id: manager })
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
        await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
        await admin.end();
      }
    });

    it('restricts management to protected Super Admin, active lookup to product readers and branch categories to scoped readers', async () => {
      for (const actor of [manager, central, noAccess]) {
        expect((await client(actor).get('/product-categories')).status).toBe(
          403,
        );
        expect(
          (
            await client(actor)
              .post('/product-categories')
              .send({ name: 'Forbidden' })
          ).status,
        ).toBe(403);
        expect(
          (
            await client(actor)
              .patch('/product-categories/' + categoryId)
              .send({ name: 'Forbidden' })
          ).status,
        ).toBe(403);
        expect(
          (
            await client(actor).post(
              '/product-categories/' + categoryId + '/deactivate',
            )
          ).status,
        ).toBe(403);
      }
      expect(
        (await client(manager).get('/product-categories/available')).status,
      ).toBe(200);
      expect(
        (await client(noAccess).get('/product-categories/available')).status,
      ).toBe(403);
      expect(
        (await client(manager).get(`/branches/${other}/products/categories`))
          .status,
      ).toBe(403);
      expect(
        (await client(noAccess).get(`/branches/${branch}/products/categories`))
          .status,
      ).toBe(403);
      expect(
        (await client(manager).get(`/branches/${branch}/products/categories`))
          .status,
      ).toBe(200);
      expect(
        (await client().get(`/branches/${randomUUID()}/products/categories`))
          .status,
      ).toBe(404);
    });

    it('trims and validates names, enforces unique names concurrently, and supports archive/reactivation with pagination', async () => {
      const made = await client()
        .post('/product-categories')
        .send({ name: '  Unique sides  ' });
      expect(made.status).toBe(201);
      expect(made.body.name).toBe('Unique sides');
      expect(Object.keys(made.body).sort()).toEqual(
        ['id', 'name', 'is_active', 'created_at', 'updated_at'].sort(),
      );
      expect(
        (
          await client()
            .post('/product-categories')
            .send({ name: 'unique SIDES' })
        ).status,
      ).toBe(409);
      for (const name of ['', ' ', 'x', 'a'.repeat(81), null, 12])
        expect(
          (await client().post('/product-categories').send({ name })).status,
        ).toBe(400);
      for (const input of [
        { name: null },
        { is_active: null },
        { is_active: 'true' },
        {},
      ])
        expect(
          (
            await client()
              .patch('/product-categories/' + made.body.id)
              .send(input)
          ).status,
        ).toBe(400);
      expect(
        (
          await client()
            .patch('/product-categories/' + made.body.id)
            .send({ name: 'Renamed sides' })
        ).body.name,
      ).toBe('Renamed sides');
      expect(
        (
          await client().post(
            '/product-categories/' + made.body.id + '/deactivate',
          )
        ).body.is_active,
      ).toBe(false);
      const filtered = await client().get(
        '/product-categories?search=renamed&is_active=false&page_size=1',
      );
      expect(filtered.body).toMatchObject({
        total: 1,
        page: 1,
        page_size: 1,
        items: [{ id: made.body.id }],
      });
      expect(
        (
          await client(manager).get(
            '/product-categories/available?search=renamed',
          )
        ).body.total,
      ).toBe(0);
      expect(
        (
          await client()
            .patch('/product-categories/' + made.body.id)
            .send({ is_active: true })
        ).body.is_active,
      ).toBe(true);
      expect(
        (
          await client(manager).get(
            '/product-categories/available?search=renamed&page_size=1',
          )
        ).body.total,
      ).toBe(1);
      const uniqueName = 'Concurrent ' + randomUUID();
      const results = await Promise.all([
        client().post('/product-categories').send({ name: uniqueName }),
        client()
          .post('/product-categories')
          .send({ name: uniqueName.toUpperCase() }),
      ]);
      expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([
        201, 409,
      ]);
    });

    it('requires category on create/setup, rejects null partial edits and inactive/unknown selections atomically', async () => {
      const { category_id: _category, ...missing } = details();
      for (const value of [
        missing,
        { ...details(), category_id: null },
        { ...details(), category_id: 'bad' },
      ]) {
        expect((await client().post('/products').send(value)).status).toBe(400);
        expect(
          (
            await client()
              .post('/products/setup')
              .set('Idempotency-Key', randomUUID())
              .send({ product: value, expected_product_revision: 0 })
          ).status,
        ).toBe(400);
      }
      const archived = await category();
      await client().post('/product-categories/' + archived.id + '/deactivate');
      expect(
        (await client().post('/products').send(details(archived.id))).status,
      ).toBe(409);
      expect(
        (await client().post('/products').send(details(randomUUID()))).status,
      ).toBe(404);
      const current = await product();
      for (const [id, status] of [
        [null, 400],
        [archived.id, 409],
        [randomUUID(), 404],
      ] as const) {
        expect(
          (
            await client()
              .patch('/products/' + current.id)
              .send({
                category_id: id,
                price: '999',
                expected_product_revision: current.setup_revision,
              })
          ).status,
        ).toBe(status);
      }
      const unchanged = await client().get('/products/' + current.id);
      expect(unchanged.body).toMatchObject({
        category_id: categoryId,
        price: '125.005',
        price_revision: 1,
        setup_revision: 1,
        category_name: 'Rice meals',
        category_is_active: true,
      });
      const updated = await client()
        .patch('/products/' + current.id)
        .send({ description: 'Changed', expected_product_revision: 1 });
      expect(updated.status).toBe(200);
      expect(updated.body.category_id).toBe(categoryId);
    });

    it('blocks both archive paths until active products move or deactivate and never increments price revision for category changes', async () => {
      const source = await category(),
        target = await category(),
        current = await product(source.id);
      expect(
        (
          await client().post(
            '/product-categories/' + source.id + '/deactivate',
          )
        ).status,
      ).toBe(409);
      expect(
        (
          await client()
            .patch('/product-categories/' + source.id)
            .send({ name: 'Blocked rename', is_active: false })
        ).status,
      ).toBe(409);
      const updated = await client()
        .patch('/products/' + current.id)
        .send({
          category_id: target.id,
          expected_product_revision: current.setup_revision,
        });
      expect(updated.status).toBe(200);
      expect(updated.body).toMatchObject({
        category_id: target.id,
        category_name: target.name,
        category_is_active: true,
        price_revision: current.price_revision,
        setup_revision: 2,
      });
      expect(
        (
          await client()
            .patch('/products/' + current.id)
            .send({ category_id: source.id, expected_product_revision: 1 })
        ).status,
      ).toBe(409);
      expect(
        (
          await client().post(
            '/product-categories/' + source.id + '/deactivate',
          )
        ).status,
      ).toBe(201);
      expect(
        (await client().post('/products/' + current.id + '/deactivate')).body
          .category_id,
      ).toBe(target.id);
      expect(
        (
          await client().post(
            '/product-categories/' + target.id + '/deactivate',
          )
        ).status,
      ).toBe(201);
      const detail = await client().get('/products/' + current.id);
      expect(detail.body.category_is_active).toBe(false);
      const partial = await client()
        .patch('/products/' + current.id)
        .send({
          description: 'Historical',
          expected_product_revision: detail.body.setup_revision,
        });
      expect(partial.status).toBe(200);
      const list = await client().get(
        '/products?search=' + encodeURIComponent(detail.body.product_name),
      );
      expect(list.body.items[0]).toMatchObject({
        category_id: target.id,
        category_name: target.name,
        category_is_active: false,
      });
    });

    it('keeps retries stable, fingerprints category changes and fills category metadata in legacy saved results', async () => {
      const key = randomUUID(),
        input = { product: details(), expected_product_revision: 0 };
      const post = () =>
        client()
          .post('/products/setup')
          .set('Idempotency-Key', key)
          .send(input);
      const saved = await post();
      expect(saved.status).toBe(201);
      expect((await post()).body).toEqual(saved.body);
      const otherCategory = await category();
      expect(
        (
          await client()
            .post('/products/setup')
            .set('Idempotency-Key', key)
            .send({
              ...input,
              product: { ...input.product, category_id: otherCategory.id },
            })
        ).status,
      ).toBe(409);
      const legacy = structuredClone(saved.body);
      delete legacy.product.category_id;
      delete legacy.product.category_name;
      delete legacy.product.category_is_active;
      await db
        .updateTable('product_setup_operations')
        .set({ result: JSON.stringify(legacy) })
        .where('idempotency_key', '=', key)
        .execute();
      const normalized = await post();
      expect(normalized.status).toBe(201);
      expect(normalized.body).toEqual(saved.body);
      expect(
        (await client().get('/products/' + saved.body.product.id + '/setup'))
          .body.product.category_id,
      ).toBe(categoryId);
    });

    it('filters category before page/count and lists distinct eligible categories independently of product search or pagination', async () => {
      const a = await category(),
        b = await category(),
        hidden = await category();
      const one = await product(a.id),
        two = await product(a.id),
        three = await product(b.id),
        unavailable = await product(hidden.id);
      await client()
        .post(`/branches/${branch}/products/${unavailable.id}/availability`)
        .send({ is_available: false });
      await client()
        .patch(`/branches/${branch}/products/${three.id}/services`)
        .send({ service_types: ['TAKEAWAY'] });
      const result = await client(manager).get(
        `/branches/${branch}/products?category_id=${a.id}&eligible_only=true&page_size=1&page=2`,
      );
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({ total: 2, page: 2, page_size: 1 });
      expect(result.body.items).toHaveLength(1);
      expect(result.body.items[0]).toMatchObject({
        category_id: a.id,
        category_name: a.name,
        category_is_active: true,
      });
      const get = await client(manager).get(
        `/branches/${branch}/products/${one.id}`,
      );
      expect(get.body.category_name).toBe(a.name);
      const choices = (
        await client(manager).get(`/branches/${branch}/products/categories`)
      ).body;
      expect(choices.filter((c: { id: string }) => c.id === a.id)).toEqual([
        { id: a.id, name: a.name },
      ]);
      expect(choices).toContainEqual({ id: b.id, name: b.name });
      expect(choices).not.toContainEqual({ id: hidden.id, name: hidden.name });
      const dine = (
        await client(manager).get(
          `/branches/${branch}/products/categories?service_type=DINE_IN`,
        )
      ).body;
      expect(dine).not.toContainEqual({ id: b.id, name: b.name });
      const search = await client(manager).get(
        `/branches/${branch}/products?category_id=${a.id}&search=NoMatchingProduct`,
      );
      expect(search.body.total).toBe(0);
      expect(
        (await client(manager).get(`/branches/${branch}/products/categories`))
          .body,
      ).toEqual(choices);
      expect(
        (
          await client(manager).get(
            `/branches/${branch}/products?category_id=invalid`,
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await client(manager).get(
            `/branches/${branch}/products/categories?service_type=DELIVERY`,
          )
        ).status,
      ).toBe(400);
      await client().post('/products/' + one.id + '/deactivate');
      await client().post('/products/' + two.id + '/deactivate');
      expect(
        (await client(manager).get(`/branches/${branch}/products/categories`))
          .body,
      ).not.toContainEqual({ id: a.id, name: a.name });
      await db
        .updateTable('branches')
        .set({ status: 'inactive' })
        .where('id', '=', branch)
        .execute();
      expect(
        (await client().get(`/branches/${branch}/products/categories`)).body,
      ).toEqual([]);
      await db
        .updateTable('branches')
        .set({ status: 'active' })
        .where('id', '=', branch)
        .execute();
    });

    it('serializes archive against concurrent creates and reassignment without leaving active products in archived categories', async () => {
      for (let i = 0; i < 5; i++) {
        const target = await category();
        const results = await Promise.all([
          client().post('/products').send(details(target.id)),
          client().post('/product-categories/' + target.id + '/deactivate'),
        ]);
        expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([
          201, 409,
        ]);
        const destination = await category(),
          current = await product();
        const updates = await Promise.all([
          client()
            .patch('/products/' + current.id)
            .send({
              category_id: destination.id,
              expected_product_revision: 1,
            }),
          client().post(
            '/product-categories/' + destination.id + '/deactivate',
          ),
        ]);
        expect(updates.map((r) => r.status).sort((a, b) => a - b)).toEqual(
          expect.arrayContaining([409]),
        );
        expect(updates.some((r) => r.status === 200 || r.status === 201)).toBe(
          true,
        );
      }
      const invalid = await db
        .selectFrom('products as p')
        .innerJoin('product_categories as c', 'c.id', 'p.category_id')
        .select('p.id')
        .where('p.is_active', '=', true)
        .where('c.is_active', '=', false)
        .execute();
      expect(invalid).toEqual([]);
    });

    it('rechecks committed state after waiting on category locks in both race directions', async () => {
      async function waitForCategoryLock() {
        for (let attempt = 0; attempt < 200; attempt++) {
          const waiting = await sql<{
            count: string;
          }>`SELECT count(*) FROM pg_stat_activity
            WHERE datname=current_database() AND pid<>pg_backend_pid()
            AND wait_event_type='Lock' AND query ILIKE '%product_categories%'`.execute(
            db,
          );
          if (Number(waiting.rows[0].count) > 0) return;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error('Expected a category lock wait');
      }
      const assigned = await category();
      let archive: Promise<request.Response> | undefined;
      await db.transaction().execute(async (tx) => {
        await tx
          .selectFrom('product_categories')
          .select('id')
          .where('id', '=', assigned.id)
          .forShare()
          .execute();
        await tx
          .insertInto('products')
          .values({
            product_name: 'Uncommitted assignment',
            price: '1',
            category_id: assigned.id,
          })
          .execute();
        archive = client()
          .post('/product-categories/' + assigned.id + '/deactivate')
          .then((result) => result);
        await waitForCategoryLock();
      });
      expect((await archive!).status).toBe(409);

      const archived = await category();
      let save: Promise<request.Response> | undefined;
      await db.transaction().execute(async (tx) => {
        await tx
          .selectFrom('product_categories')
          .select('id')
          .where('id', '=', archived.id)
          .forUpdate()
          .execute();
        await tx
          .updateTable('product_categories')
          .set({ is_active: false })
          .where('id', '=', archived.id)
          .execute();
        save = client()
          .post('/products')
          .send(details(archived.id))
          .then((result) => result);
        await waitForCategoryLock();
      });
      expect((await save!).status).toBe(409);
    });

    it('backfills every approved name and preserves product data through rollback; unknown names and active legacy names fail', async () => {
      await db.transaction().execute(async (tx) => {
        const schema = 'category_migration_' + randomUUID().replaceAll('-', '');
        await sql.raw(`CREATE SCHEMA "${schema}"`).execute(tx);
        await sql
          .raw(`SET LOCAL search_path TO "${schema}", public`)
          .execute(tx);
        await sql`CREATE TABLE products (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), product_name text NOT NULL, is_active boolean NOT NULL, price numeric NOT NULL)`.execute(
          tx,
        );
        const rows = Object.entries(categoryProductNames).flatMap(
          ([name, names]) =>
            names.map((product_name) => ({
              product_name,
              is_active: name !== 'Legacy items',
              price: '125.005',
            })),
        );
        await tx
          .insertInto('products')
          .values(rows as never)
          .execute();
        await up(tx);
        const mapped = await tx
          .selectFrom('products as p')
          .innerJoin('product_categories as c', 'c.id', 'p.category_id')
          .select(['p.product_name', 'p.price', 'c.name'])
          .execute();
        expect(mapped).toHaveLength(36);
        for (const row of mapped) {
          expect(categoryProductNames[row.name]).toContain(row.product_name);
          expect(row.price).toBe('125.005');
        }
        await down(tx);
        expect(
          await tx.selectFrom('products').select('id').execute(),
        ).toHaveLength(36);
        await sql.raw(`DROP SCHEMA "${schema}" CASCADE`).execute(tx);
      });
      for (const [productName, active, message] of [
        ['Unknown mapping', true, 'Unmapped products'],
        ['TEST', true, 'Active products cannot enter'],
      ] as const) {
        await expect(
          db.transaction().execute(async (tx) => {
            const schema =
              'category_reject_' + randomUUID().replaceAll('-', '');
            await sql.raw(`CREATE SCHEMA "${schema}"`).execute(tx);
            await sql
              .raw(`SET LOCAL search_path TO "${schema}", public`)
              .execute(tx);
            await sql`CREATE TABLE products (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), product_name text, is_active boolean)`.execute(
              tx,
            );
            await sql`INSERT INTO products(product_name,is_active) VALUES (${productName},${active})`.execute(
              tx,
            );
            await up(tx);
          }),
        ).rejects.toThrow(message);
      }
    });
  },
);
