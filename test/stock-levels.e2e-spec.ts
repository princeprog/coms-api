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

type Row = Record<string, unknown>;

describe.skipIf(process.env.COMS_RUN_DB_TESTS !== '1')('stock levels', () => {
  const name = 'coms_levels_test_' + randomUUID().replaceAll('-', '');
  let admin: Pool;
  let db: Kysely<DB>;
  let app: INestApplication;
  let owner: string, commissary: string, dispatcher: string, viewer: string;
  let branchA: string, branchB: string;
  let rice: string, box: string, retired: string;
  const as = (actor: string) => ({
    get: (path: string) =>
      request(app.getHttpServer()).get(path).set('x-test-actor', actor),
    put: (path: string) =>
      request(app.getHttpServer()).put(path).set('x-test-actor', actor),
  });
  const counts = (attention: { key: string; count: number }[]) =>
    Object.fromEntries(attention.map((item) => [item.key, item.count]));
  const byName = (items: Row[]) =>
    Object.fromEntries(items.map((item) => [item.stock_item_name, item]));

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
            email: label + '@levels.invalid',
            full_name: 'Levels ' + label,
            contact_number: 'levels-' + label,
            hashed_password: 'test-only',
            role_id: roleId,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    owner = await user(
      'owner',
      (
        await db
          .selectFrom('coms_auth.roles')
          .select('id')
          .where('code', '=', 'SUPER_ADMIN')
          .executeTakeFirstOrThrow()
      ).id,
    );
    commissary = await user(
      'commissary',
      await role('LEVELS_COMMISSARY', [
        'inventory.levels_manage',
        'inventory.read',
        'inventory.commissary_read',
        'dispatches.create',
        'dispatches.dispatch',
      ]),
    );
    dispatcher = await user(
      'dispatcher',
      await role('LEVELS_DISPATCHER', [
        'dispatches.create',
        'dispatches.dispatch',
      ]),
    );
    viewer = await user(
      'viewer',
      await role('LEVELS_VIEWER', ['inventory.read', 'dashboard.read']),
    );
    const newBranch = async (code: string) =>
      (
        await db
          .insertInto('branches')
          .values({ code, branch_name: 'Levels ' + code })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    branchA = await newBranch('LVL-A');
    branchB = await newBranch('LVL-B');
    await db
      .insertInto('coms_auth.branch_users')
      .values([
        { branch_id: branchA, user_id: commissary },
        { branch_id: branchA, user_id: dispatcher },
        { branch_id: branchA, user_id: viewer },
      ])
      .execute();
    const stock = async (stock_item_name: string, is_active = true) =>
      (
        await db
          .insertInto('stock_items')
          .values({
            stock_item_name,
            category: 'Levels test',
            unit: 'kg',
            is_active,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    rice = await stock('Levels rice');
    box = await stock('Levels box');
    retired = await stock('Levels retired', false);
    await db
      .insertInto('branch_inventory')
      .values([
        { branch_id: branchA, stock_item_id: rice, quantity_on_hand: '3' },
        { branch_id: branchA, stock_item_id: box, quantity_on_hand: '-1' },
      ])
      .execute();
    await db
      .insertInto('commissary_inventory')
      .values([{ stock_item_id: rice, quantity_on_hand: '8' }])
      .execute();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await db?.destroy();
    await admin?.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin?.end();
  });

  it('validates levels and enforces permission and branch access', async () => {
    const put = (actor: string, body: object) =>
      as(actor).put('/inventory/levels').send(body);
    const branch = {
      stock_item_id: rice,
      scope: 'BRANCH',
      branch_ids: [branchA],
    };
    expect(
      (await put(owner, { ...branch, reorder_level: '5', target_level: '5' }))
        .body.message,
    ).toBe('Target level must be more than the reorder level');
    expect(
      (await put(owner, { ...branch, reorder_level: '5', target_level: null }))
        .status,
    ).toBe(400);
    expect(
      (await put(owner, { ...branch, reorder_level: '-1', target_level: '5' }))
        .status,
    ).toBe(400);
    expect(
      (
        await put(owner, {
          stock_item_id: rice,
          scope: 'COMMISSARY',
          branch_ids: [branchA],
          reorder_level: '1',
          target_level: '2',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await put(owner, {
          ...branch,
          stock_item_id: retired,
          reorder_level: '1',
          target_level: '2',
        })
      ).status,
    ).toBe(404);
    expect(
      (await put(viewer, { ...branch, reorder_level: '1', target_level: '2' }))
        .status,
    ).toBe(403);
    expect(
      (
        await put(commissary, {
          ...branch,
          branch_ids: [branchB],
          reorder_level: '1',
          target_level: '2',
        })
      ).status,
    ).toBe(403);
  });

  it('sets levels for several branches once and audits each change', async () => {
    const body = {
      stock_item_id: rice,
      scope: 'BRANCH',
      branch_ids: [branchA, branchB],
      reorder_level: '5.0',
      target_level: '20',
    };
    const first = await as(owner).put('/inventory/levels').send(body);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ reorder_level: '5', changed: 2 });
    const again = await as(owner).put('/inventory/levels').send(body);
    expect(again.body.changed).toBe(0);

    const events = await db
      .selectFrom('audit_events')
      .select(['action', 'branch_id', 'metadata', 'changes'])
      .where('entity_id', '=', rice)
      .where('action', '=', 'stock_item.levels_set')
      .execute();
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.metadata)).toEqual(
      expect.arrayContaining([{ location: 'Levels LVL-A' }]),
    );
    expect(events[0].changes).toMatchObject({
      reorder_level: { from: null, to: '5' },
    });

    expect(
      (
        await as(commissary)
          .put('/inventory/levels')
          .send({
            stock_item_id: box,
            scope: 'BRANCH',
            branch_ids: [branchA],
            reorder_level: '2',
            target_level: '10',
          })
      ).status,
    ).toBe(200);
    expect(
      (
        await as(commissary).put('/inventory/levels').send({
          stock_item_id: rice,
          scope: 'COMMISSARY',
          reorder_level: '10',
          target_level: '50',
        })
      ).status,
    ).toBe(200);
  });

  it('shows levels, status, usage and the low-stock filter', async () => {
    const all = await as(viewer).get('/inventory/branches/' + branchA);
    expect(all.status).toBe(200);
    const items = byName(all.body.items);
    expect(items['Levels rice']).toMatchObject({
      quantity_on_hand: '3',
      on_the_way: '0',
      reorder_level: '5',
      target_level: '20',
      avg_daily_use: '0',
      stock_status: 'LOW',
    });
    expect(items['Levels box'].stock_status).toBe('BELOW_ZERO');
    expect(items['Levels retired'].stock_status).toBe('INACTIVE');

    const low = await as(viewer).get(
      '/inventory/branches/' + branchA + '?stock=low',
    );
    expect(low.body.total).toBe(2);

    const commissaryList = await as(commissary).get(
      '/inventory/commissary?stock=low',
    );
    expect(byName(commissaryList.body.items)['Levels rice']).toMatchObject({
      quantity_on_hand: '8',
      reorder_level: '10',
      stock_status: 'LOW',
    });
  });

  it('suggests dispatch quantities capped at commissary stock', async () => {
    const response = await as(commissary).get(
      '/dispatches/restock-suggestions?branch_id=' + branchA,
    );
    expect(response.status).toBe(200);
    expect(response.body.items).toEqual([
      expect.objectContaining({
        stock_item_name: 'Levels box',
        on_hand: '-1',
        suggested_quantity: '11',
        quantity_to_send: '0',
        commissary_available: '0',
      }),
      expect.objectContaining({
        stock_item_name: 'Levels rice',
        on_hand: '3',
        suggested_quantity: '17',
        quantity_to_send: '8',
        commissary_available: '8',
      }),
    ]);

    const hidden = await as(dispatcher).get(
      '/dispatches/restock-suggestions?branch_id=' + branchA,
    );
    expect(hidden.body.items[1].commissary_available).toBeNull();
    expect(
      (
        await as(dispatcher).get(
          '/dispatches/restock-suggestions?branch_id=' + branchB,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await as(viewer).get(
          '/dispatches/restock-suggestions?branch_id=' + branchA,
        )
      ).status,
    ).toBe(403);
  });

  it('counts low stock on the dashboard', async () => {
    const all = counts(
      (await as(owner).get('/dashboard/today')).body.attention,
    );
    expect(all.branch_stock_low).toBe(3);
    expect(all.commissary_stock_low).toBe(1);
    const branch = counts(
      (await as(owner).get('/dashboard/today?branch_id=' + branchA)).body
        .attention,
    );
    expect(branch.branch_stock_low).toBe(2);
    expect(branch.commissary_stock_low).toBe(0);
    const scoped = counts(
      (await as(viewer).get('/dashboard/today')).body.attention,
    );
    expect(scoped.branch_stock_low).toBe(2);
    expect(scoped).not.toHaveProperty('commissary_stock_low');
  });

  it('treats stock on the way as restocking', async () => {
    const dispatch = await db
      .insertInto('dispatches')
      .values({
        branch_id: branchA,
        created_by_user_id: owner,
        dispatched_by_user_id: owner,
        idempotency_key: randomUUID(),
        status: 'IN_TRANSIT',
        dispatched_at: new Date(),
        receive_by: new Date(Date.now() + 86_400_000),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('dispatch_items')
      .values({
        dispatch_id: dispatch.id,
        stock_item_id: rice,
        quantity_dispatched: '4',
      })
      .execute();

    const items = byName(
      (await as(viewer).get('/inventory/branches/' + branchA)).body.items,
    );
    expect(items['Levels rice']).toMatchObject({
      on_the_way: '4',
      stock_status: 'RESTOCKING',
    });
    const suggestions = await as(commissary).get(
      '/dispatches/restock-suggestions?branch_id=' + branchA,
    );
    expect(
      suggestions.body.items.map((item: Row) => item.stock_item_name),
    ).toEqual(['Levels box']);
  });

  it('clears levels and records it', async () => {
    const cleared = await as(owner)
      .put('/inventory/levels')
      .send({
        stock_item_id: rice,
        scope: 'BRANCH',
        branch_ids: [branchB],
        reorder_level: null,
        target_level: null,
      });
    expect(cleared.body).toMatchObject({ changed: 1, reorder_level: null });
    const remaining = await db
      .selectFrom('stock_levels')
      .select('branch_id')
      .where('stock_item_id', '=', rice)
      .where('inventory_scope', '=', 'BRANCH')
      .execute();
    expect(remaining).toEqual([{ branch_id: branchA }]);
    const event = await db
      .selectFrom('audit_events')
      .select(['changes'])
      .where('action', '=', 'stock_item.levels_cleared')
      .executeTakeFirstOrThrow();
    expect(event.changes).toMatchObject({
      target_level: { from: '20', to: null },
    });
  });
});
