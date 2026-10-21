import '../src/config/load-env';
import {
  ValidationPipe,
  type ExecutionContext,
  type INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
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
import { getAuthConfig } from '../src/config/auth.config';
import { createDatabase } from '../src/database/create-database';
import { DATABASE } from '../src/database/database.module';
import type { DB } from '../src/database/db';

describe.skipIf(process.env.COMS_RUN_DB_TESTS !== '1')('audit history', () => {
  const name = 'coms_audit_test_' + randomUUID().replaceAll('-', '');
  let admin: Pool;
  let db: Kysely<DB>;
  let app: INestApplication;
  let superAdmin: string, reader: string, noAccess: string;
  let stock: string, otherStock: string;
  const as = (actor: string) => ({
    get: (path: string) =>
      request(app.getHttpServer()).get(path).set('x-test-actor', actor),
    post: (path: string) =>
      request(app.getHttpServer())
        .post(path)
        .set('x-test-actor', actor)
        .set('Origin', getAuthConfig().webOrigin),
    patch: (path: string) =>
      request(app.getHttpServer()).patch(path).set('x-test-actor', actor),
  });
  const events = (action: string) =>
    db
      .selectFrom('audit_events')
      .selectAll()
      .where('action', '=', action)
      .orderBy('occurred_at')
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
    // The production factory, so request actors reach the audit triggers.
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

    const role = async (code: string, keys: string[]) => {
      const id = (
        await db
          .insertInto('auth.roles')
          .values({ code, role_name: code })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      for (const key of keys) {
        const [m, a] = key.split('.');
        await sql`INSERT INTO auth.role_permissions (role_id, permission_id)
          SELECT ${id}, id FROM auth.permissions WHERE module_key = ${m} AND action_key = ${a}`.execute(
          db,
        );
      }
      return id;
    };
    const user = async (label: string, roleId: string) =>
      (
        await db
          .insertInto('auth.users')
          .values({
            email: `${label}@audit.invalid`,
            full_name: 'Audit ' + label,
            contact_number: 'audit-' + label,
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
    superAdmin = await user('admin', superRole);
    reader = await user('reader', await role('AUDIT_READER', ['audit.read']));
    noAccess = await user('none', await role('NO_AUDIT', ['stock_items.read']));
    stock = (
      await db
        .insertInto('stock_items')
        .values({
          stock_item_name: 'Audit rice',
          category: 'Rice and grains',
          unit: 'kg',
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    otherStock = (
      await db
        .insertInto('stock_items')
        .values({
          stock_item_name: 'Audit garlic',
          category: 'Vegetables and aromatics',
          unit: 'kg',
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;

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
    app.use(cookieParser());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  }, 60000);

  afterAll(async () => {
    await app?.close();
    await db?.destroy();
    if (admin) {
      if (!name.startsWith('coms_audit_test_')) throw Error('Unsafe cleanup');
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await admin.end();
    }
  });

  it('records field changes with the acting user', async () => {
    const updated = await as(superAdmin)
      .patch(`/stock-items/${stock}`)
      .send({ unit: 'sack', recipe_use: 'OPERATING_SUPPLY' });
    expect(updated.status).toBe(200);
    const [event] = await events('stock_item.updated');
    expect(event).toMatchObject({
      actor_user_id: superAdmin,
      actor_name: 'Audit admin',
      entity_id: stock,
      entity_label: 'Audit rice',
    });
    expect(event.changes).toMatchObject({
      unit: { from: 'kg', to: 'sack' },
      usage_types: { from: ['INGREDIENT'], to: ['OPERATING_SUPPLY'] },
    });
    expect(event.changes).not.toHaveProperty('updated_at');
  });

  it('records product recipes and writes nothing for a rolled-back save', async () => {
    const category = (
      await db
        .selectFrom('product_categories')
        .select('id')
        .where('name', '=', 'Rice meals')
        .executeTakeFirstOrThrow()
    ).id;
    const created = await as(superAdmin)
      .post('/products/setup')
      .set('Idempotency-Key', randomUUID())
      .send({
        expected_product_revision: 0,
        product: {
          product_name: 'Audit meal',
          category_id: category,
          price: '120',
          service_types: ['DINE_IN', 'TAKEAWAY'],
          branch_ids: [],
        },
        recipe: [
          { stock_item_id: otherStock, quantity: '0.01', usage_scope: 'ALL' },
        ],
      });
    expect(created.status).toBe(201);
    const [recipe] = await events('product.recipe_updated');
    expect(recipe.metadata).toEqual({
      added: ['Audit garlic 0.01 kg'],
      removed: [],
    });
    expect(await events('product.created')).toHaveLength(1);

    const before = (await db.selectFrom('audit_events').select('id').execute())
      .length;
    const blocked = await as(superAdmin).post(
      `/stock-items/${otherStock}/deactivate`,
    );
    expect(blocked.status).toBe(409);
    expect(
      (await db.selectFrom('audit_events').select('id').execute()).length,
    ).toBe(before);
  });

  it('keeps history append-only and free of password hashes', async () => {
    await expect(
      db.updateTable('audit_events').set({ action: 'tampered' }).execute(),
    ).rejects.toThrow(/append-only/);
    await expect(db.deleteFrom('audit_events').execute()).rejects.toThrow(
      /append-only/,
    );
    const before = (await db.selectFrom('audit_events').select('id').execute())
      .length;
    await db
      .updateTable('auth.users')
      .set({ hashed_password: 'another-hash' })
      .where('id', '=', noAccess)
      .execute();
    expect(
      (await db.selectFrom('audit_events').select('id').execute()).length,
    ).toBe(before);
    const all = JSON.stringify(
      await db.selectFrom('audit_events').selectAll().execute(),
    );
    expect(all).not.toContain('hashed_password');
  });

  it('records failed sign-ins without an actor', async () => {
    const failed = await request(app.getHttpServer())
      .post('/auth/login')
      .set('Origin', getAuthConfig().webOrigin)
      .send({ email: 'admin@audit.invalid', password: 'wrong-password-123' });
    expect(failed.status).toBe(401);
    const [event] = await events('auth.sign_in_failed');
    expect(event).toMatchObject({ actor_user_id: null, entity_id: superAdmin });
    expect(event.metadata).toEqual({ email: 'admin@audit.invalid' });
  });

  it('lets only audit readers list and filter events', async () => {
    expect((await as(noAccess).get('/audit-events')).status).toBe(403);
    const filtered = await as(reader).get(
      '/audit-events?entity_type=stock_item&search=rice&page=1&page_size=10',
    );
    expect(filtered.status).toBe(200);
    expect(filtered.body.items.length).toBeGreaterThan(0);
    expect(
      filtered.body.items.every(
        (e: { entity_type: string }) => e.entity_type === 'stock_item',
      ),
    ).toBe(true);
    const products = await as(reader).get(
      '/audit-events?entity_type=product&search=Audit%20meal',
    );
    const created = products.body.items.find(
      (e: { action: string }) => e.action === 'product.created',
    );
    expect(created.changes.category_id).toEqual({
      from: null,
      to: 'Rice meals',
    });
  });
});
