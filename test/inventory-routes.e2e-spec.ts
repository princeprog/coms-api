import '../src/config/load-env';
import {
  ExecutionContext,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { Kysely } from 'kysely';
import request from 'supertest';
import type { App } from 'supertest/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccessContext } from '../src/modules/access-control/access-control.types';
import { AccessControlGuard } from '../src/common/guards/access-control.guard';
import { AuthGatewayGuard } from '../src/common/guards/auth-gateway.guard';
import { AuthGuard } from '../src/common/guards/auth.guard';
import { AppModule } from '../src/app.module';
import { DATABASE } from '../src/database/database.module';
import type { DB } from '../src/database/db';

type TestRequest = {
  user?: { id: string };
  accessContext?: AccessContext;
};

describe('inventory routes (e2e)', () => {
  const suffix = randomUUID();
  const stockItemIds: string[] = [];
  let branchId: string;
  let inactiveBranchId: string | undefined;
  let actorUserId: string;
  let branchIds: string[] = [];
  let app: INestApplication<App>;
  let guardedApp: INestApplication<App>;
  let db: Kysely<DB>;

  beforeAll(async () => {
    const guardedModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    guardedApp = guardedModule.createNestApplication();
    await guardedApp.init();

    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideGuard(AuthGatewayGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(AuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(AccessControlGuard)
      .useValue({
        canActivate: (execution: ExecutionContext) => {
          const currentRequest = execution
            .switchToHttp()
            .getRequest<TestRequest>();
          currentRequest.user = { id: actorUserId };
          currentRequest.accessContext = {
            userId: actorUserId,
            accountActive: true,
            role: {
              id: 'test-role',
              code: 'INVENTORY_TEST',
              name: 'Inventory Test',
              isSystem: false,
              isActive: true,
            },
            permissions: ['inventory.read', 'inventory.adjust'],
            branchIds,
          };
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
    db = app.get<Kysely<DB>>(DATABASE);

    const actor = await db
      .selectFrom('auth.users')
      .select('id')
      .limit(1)
      .executeTakeFirstOrThrow();
    actorUserId = actor.id;

    const branch = await db
      .insertInto('branches')
      .values({ code: `INV-${suffix}`, branch_name: `Inventory ${suffix}` })
      .returning('id')
      .executeTakeFirstOrThrow();
    branchId = branch.id;
    branchIds = [branchId];

    const first = await createStockItem(`Inventory ${suffix}`);
    stockItemIds.push(first);
  });

  afterAll(async () => {
    if (stockItemIds.length) {
      await db
        .deleteFrom('inventory_movements')
        .where('stock_item_id', 'in', stockItemIds)
        .execute();
      await db
        .deleteFrom('branch_inventory')
        .where('stock_item_id', 'in', stockItemIds)
        .execute();
      await db
        .deleteFrom('commissary_inventory')
        .where('stock_item_id', 'in', stockItemIds)
        .execute();
      await db
        .deleteFrom('stock_items')
        .where('id', 'in', stockItemIds)
        .execute();
    }
    if (branchId) {
      await db.deleteFrom('branches').where('id', '=', branchId).execute();
    }
    if (inactiveBranchId) {
      await db
        .deleteFrom('branches')
        .where('id', '=', inactiveBranchId)
        .execute();
    }
    await Promise.all([app.close(), guardedApp.close()]);
  });

  it.each([
    { method: 'GET', path: '/inventory/commissary' },
    { method: 'GET', path: '/inventory/commissary/movements' },
    { method: 'POST', path: '/inventory/commissary/adjustments' },
    {
      method: 'GET',
      path: '/inventory/branches/00000000-0000-4000-8000-000000000001',
    },
    {
      method: 'GET',
      path: '/inventory/branches/00000000-0000-4000-8000-000000000001/movements',
    },
    {
      method: 'POST',
      path: '/inventory/branches/00000000-0000-4000-8000-000000000001/adjustments',
    },
  ])('requires the authentication gateway for $method $path', async (route) => {
    const client = request(guardedApp.getHttpServer());
    const response =
      route.method === 'GET'
        ? await client.get(route.path)
        : await client.post(route.path);
    expect(response.status).toBe(403);
    expect(response.body.message).toBe('Authentication gateway required');
  });

  it('validates adjustment input and requires an idempotency key', async () => {
    const path = '/inventory/commissary/adjustments';
    const missingKey = await request(app.getHttpServer()).post(path).send({
      stock_item_id: stockItemIds[0],
      quantity_delta: '1',
      reason: 'Opening count',
    });
    const invalidKey = await request(app.getHttpServer())
      .post(path)
      .set('Idempotency-Key', 'not-a-uuid')
      .send({
        stock_item_id: stockItemIds[0],
        quantity_delta: '1',
        reason: 'Opening count',
      });
    const invalidDecimal = await request(app.getHttpServer())
      .post(path)
      .set('Idempotency-Key', randomUUID())
      .send({
        stock_item_id: stockItemIds[0],
        quantity_delta: '1e3',
        reason: 'Opening count',
      });
    const blankReason = await request(app.getHttpServer())
      .post(path)
      .set('Idempotency-Key', randomUUID())
      .send({
        stock_item_id: stockItemIds[0],
        quantity_delta: '1',
        reason: '   ',
      });
    const zeroDelta = await request(app.getHttpServer())
      .post(path)
      .set('Idempotency-Key', randomUUID())
      .send({
        stock_item_id: stockItemIds[0],
        quantity_delta: '0.00',
        reason: 'Opening count',
      });

    expect(missingKey.status).toBe(400);
    expect(invalidKey.status).toBe(400);
    expect(invalidDecimal.status).toBe(400);
    expect(blankReason.status).toBe(400);
    expect(zeroDelta.status).toBe(400);
  });

  it('posts a commissary adjustment once, rejects conflicting retries, and prevents negative stock', async () => {
    const path = '/inventory/commissary/adjustments';
    const idempotencyKey = randomUUID();
    const adjustment = {
      stock_item_id: stockItemIds[0],
      quantity_delta: '2.750',
      reason: 'Opening stock count',
    };
    const retryAdjustment = { ...adjustment, quantity_delta: '2.75' };

    const posted = await request(app.getHttpServer())
      .post(path)
      .set('Idempotency-Key', idempotencyKey)
      .send(retryAdjustment);
    const retried = await request(app.getHttpServer())
      .post(path)
      .set('Idempotency-Key', idempotencyKey)
      .send(adjustment);
    const conflict = await request(app.getHttpServer())
      .post(path)
      .set('Idempotency-Key', idempotencyKey)
      .send({ ...adjustment, quantity_delta: '3' });
    const insufficient = await request(app.getHttpServer())
      .post(path)
      .set('Idempotency-Key', randomUUID())
      .send({ ...adjustment, quantity_delta: '-20' });

    expect(posted.status).toBe(201);
    expect(posted.body).toMatchObject({
      inventory_scope: 'COMMISSARY',
      branch_id: null,
      quantity_delta: '2.75',
      reason: 'Opening stock count',
      actor_user_id: actorUserId,
    });
    expect(retried.status).toBe(201);
    expect(retried.body.id).toBe(posted.body.id);
    expect(conflict.status).toBe(409);
    expect(insufficient.status).toBe(400);

    const balance = await request(app.getHttpServer()).get(
      `/inventory/commissary?search=${encodeURIComponent(`Inventory ${suffix}`)}`,
    );
    const movements = await request(app.getHttpServer()).get(
      `/inventory/commissary/movements?stock_item_id=${stockItemIds[0]}`,
    );
    expect(balance.body.items[0].quantity_on_hand).toBe('2.75');
    expect(movements.body).toMatchObject({ total: 1 });
    expect(movements.body.items[0].id).toBe(posted.body.id);
  });

  it('serializes simultaneous first adjustments and keeps branch balances separate', async () => {
    const concurrentItemId = await createStockItem(
      `Concurrent inventory ${suffix}`,
    );
    stockItemIds.push(concurrentItemId);
    const postAdjustment = (delta: string) =>
      request(app.getHttpServer())
        .post('/inventory/commissary/adjustments')
        .set('Idempotency-Key', randomUUID())
        .send({
          stock_item_id: concurrentItemId,
          quantity_delta: delta,
          reason: 'Concurrent opening count',
        });

    const [first, second] = await Promise.all([
      postAdjustment('3'),
      postAdjustment('4'),
    ]);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    const branchAdjustment = await request(app.getHttpServer())
      .post(`/inventory/branches/${branchId}/adjustments`)
      .set('Idempotency-Key', randomUUID())
      .send({
        stock_item_id: stockItemIds[0],
        quantity_delta: '1.25',
        reason: 'Branch opening count',
      });
    const branchInventory = await request(app.getHttpServer()).get(
      `/inventory/branches/${branchId}?search=${encodeURIComponent(`Inventory ${suffix}`)}`,
    );
    const branchMovements = await request(app.getHttpServer()).get(
      `/inventory/branches/${branchId}/movements?stock_item_id=${stockItemIds[0]}`,
    );
    const commissary = await request(app.getHttpServer()).get(
      `/inventory/commissary?search=${encodeURIComponent(`Inventory ${suffix}`)}`,
    );
    const concurrentInventory = await request(app.getHttpServer()).get(
      `/inventory/commissary?search=${encodeURIComponent(`Concurrent inventory ${suffix}`)}`,
    );

    expect(branchAdjustment.status).toBe(201);
    expect(branchAdjustment.body).toMatchObject({
      inventory_scope: 'BRANCH',
      branch_id: branchId,
      quantity_delta: '1.25',
    });
    expect(
      branchInventory.body.items.find(
        (item: { id: string }) => item.id === stockItemIds[0],
      ).quantity_on_hand,
    ).toBe('1.25');
    expect(branchMovements.body.items[0].branch_id).toBe(branchId);
    expect(
      commissary.body.items.find(
        (item: { id: string }) => item.id === stockItemIds[0],
      ).quantity_on_hand,
    ).toBe('2.75');
    expect(concurrentInventory.body.items[0].quantity_on_hand).toBe('7');
  });

  it('rejects branch inventory reads for unknown branches and adjustments for inactive branches', async () => {
    const unknownBranchId = randomUUID();
    const unknownInventory = await request(app.getHttpServer()).get(
      `/inventory/branches/${unknownBranchId}`,
    );
    const unknownMovements = await request(app.getHttpServer()).get(
      `/inventory/branches/${unknownBranchId}/movements`,
    );
    const inactiveBranch = await db
      .insertInto('branches')
      .values({
        code: `INACTIVE-${suffix}`,
        branch_name: `Inactive inventory ${suffix}`,
        status: 'inactive',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    inactiveBranchId = inactiveBranch.id;
    const inactiveAdjustment = await request(app.getHttpServer())
      .post(`/inventory/branches/${inactiveBranchId}/adjustments`)
      .set('Idempotency-Key', randomUUID())
      .send({
        stock_item_id: stockItemIds[0],
        quantity_delta: '1',
        reason: 'Inactive branch count',
      });
    const inactiveBalance = await db
      .selectFrom('branch_inventory')
      .select('quantity_on_hand')
      .where('branch_id', '=', inactiveBranchId)
      .where('stock_item_id', '=', stockItemIds[0])
      .executeTakeFirst();

    expect(unknownInventory.status).toBe(404);
    expect(unknownMovements.status).toBe(404);
    expect(inactiveAdjustment.status).toBe(404);
    expect(inactiveBalance).toBeUndefined();
  });

  it('posts concurrent retries with one idempotency key only once', async () => {
    const idempotentItemId = await createStockItem(
      `Idempotent inventory ${suffix}`,
    );
    stockItemIds.push(idempotentItemId);
    const idempotencyKey = randomUUID();
    const path = '/inventory/commissary/adjustments';
    const post = () =>
      request(app.getHttpServer())
        .post(path)
        .set('Idempotency-Key', idempotencyKey)
        .send({
          stock_item_id: idempotentItemId,
          quantity_delta: '5',
          reason: 'Concurrent duplicate request',
        });

    const [first, retry] = await Promise.all([post(), post()]);
    const inventory = await request(app.getHttpServer()).get(
      `/inventory/commissary?search=${encodeURIComponent(`Idempotent inventory ${suffix}`)}`,
    );
    const movements = await request(app.getHttpServer()).get(
      `/inventory/commissary/movements?stock_item_id=${idempotentItemId}`,
    );

    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(retry.body.id).toBe(first.body.id);
    expect(inventory.body.items[0].quantity_on_hand).toBe('5');
    expect(movements.body.total).toBe(1);
  });

  it('rejects an idempotency key already used for a different movement type', async () => {
    const movementItemId = await createStockItem(`Existing movement ${suffix}`);
    stockItemIds.push(movementItemId);
    const idempotencyKey = randomUUID();
    await db
      .insertInto('inventory_movements')
      .values({
        inventory_scope: 'COMMISSARY',
        branch_id: null,
        stock_item_id: movementItemId,
        movement_type: 'RECEIPT',
        quantity_delta: '1',
        reason: 'Opening receipt',
        actor_user_id: actorUserId,
        idempotency_key: idempotencyKey,
      })
      .execute();

    const response = await request(app.getHttpServer())
      .post('/inventory/commissary/adjustments')
      .set('Idempotency-Key', idempotencyKey)
      .send({
        stock_item_id: movementItemId,
        quantity_delta: '1',
        reason: 'Opening receipt',
      });
    const balance = await db
      .selectFrom('commissary_inventory')
      .select('quantity_on_hand')
      .where('stock_item_id', '=', movementItemId)
      .executeTakeFirst();

    expect(response.status).toBe(409);
    expect(balance).toBeUndefined();
  });

  async function createStockItem(name: string): Promise<string> {
    const stockItem = await db
      .insertInto('stock_items')
      .values({ stock_item_name: name, category: 'Test', unit: 'kg' })
      .returning('id')
      .executeTakeFirstOrThrow();
    return stockItem.id;
  }
});
