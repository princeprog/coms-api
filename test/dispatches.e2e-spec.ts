import '../src/config/load-env';
import {
  ExecutionContext,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { sql, type Kysely } from 'kysely';
import request from 'supertest';
import type { App } from 'supertest/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccessControlGuard } from '../src/common/guards/access-control.guard';
import { AuthGatewayGuard } from '../src/common/guards/auth-gateway.guard';
import { AuthGuard } from '../src/common/guards/auth.guard';
import type { AccessContext } from '../src/modules/access-control/access-control.types';
import { AppModule } from '../src/app.module';
import { DATABASE } from '../src/database/database.module';
import type { DB } from '../src/database/db';

type TestRequest = {
  user?: { id: string };
  accessContext?: AccessContext;
};

describe('dispatch routes (e2e)', () => {
  const suffix = randomUUID();
  const dispatchIds: string[] = [];
  const stockItemIds: string[] = [];
  const branchIdsToDelete: string[] = [];
  const userIdsToDelete: string[] = [];
  let branchId: string;
  let otherBranchId: string;
  let actorUserId: string;
  let deniedUserId: string;
  let receiverUserId: string;
  let currentUserId: string;
  let branchIds: string[] = [];
  let sendPermissions: AccessContext['permissions'] = [
    'dispatches.read',
    'dispatches.create',
    'dispatches.dispatch',
    'dispatches.receive',
    'dispatches.shortage_close',
    'dispatches.reconcile',
  ];
  let app: INestApplication<App>;
  let guardedApp: INestApplication<App>;
  let deniedPermissionApp: INestApplication<App>;
  let db: Kysely<DB>;

  beforeAll(async () => {
    const target = new URL(process.env.DATABASE_URL!).pathname.slice(1);
    if (
      !target.startsWith('coms_dispatch_test_') ||
      target !== process.env.COMS_TEST_DATABASE_NAME
    )
      throw new Error(
        'Run dispatch integration using node scripts/test-disposable-db.cjs',
      );
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
          currentRequest.user = { id: currentUserId };
          currentRequest.accessContext = {
            userId: currentUserId,
            accountActive: true,
            role: {
              id: 'dispatch-test-role',
              code: 'DISPATCH_TEST',
              name: 'Dispatch Test',
              isSystem: false,
              isActive: true,
            },
            permissions: sendPermissions,
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

    actorUserId = (
      await db
        .selectFrom('auth.users')
        .select('id')
        .limit(1)
        .executeTakeFirstOrThrow()
    ).id;
    currentUserId = actorUserId;

    const cashierRole = await db
      .selectFrom('auth.roles')
      .select('id')
      .where('code', '=', 'CASHIER')
      .executeTakeFirstOrThrow();
    deniedUserId = (
      await db
        .insertInto('auth.users')
        .values({
          email: `dispatch-denied-${suffix}@example.com`,
          full_name: 'Dispatch permission test',
          contact_number: `DP-${suffix.slice(0, 16)}`,
          hashed_password: 'test-only-hash',
          role_id: cashierRole.id,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    userIdsToDelete.push(deniedUserId);
    receiverUserId = (
      await db
        .insertInto('auth.users')
        .values({
          email: `dispatch-receiver-${suffix}@example.com`,
          full_name: 'Dispatch receiver test',
          contact_number: `DR-${suffix.slice(0, 16)}`,
          hashed_password: 'test-only-hash',
          role_id: cashierRole.id,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    userIdsToDelete.push(receiverUserId);
    branchId = await createBranch(`Dispatch ${suffix}`);
    otherBranchId = await createBranch(`Other Dispatch ${suffix}`);
    branchIds = [branchId];
    stockItemIds.push(
      await createStockItem(`Dispatch flour ${suffix}`),
      await createStockItem(`Dispatch oil ${suffix}`),
    );

    const deniedModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideGuard(AuthGatewayGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(AuthGuard)
      .useValue({
        canActivate: (execution: ExecutionContext) => {
          execution.switchToHttp().getRequest<TestRequest>().user = {
            id: deniedUserId,
          };
          return true;
        },
      })
      .compile();
    deniedPermissionApp = deniedModule.createNestApplication();
    await deniedPermissionApp.init();
  });

  afterAll(async () => {
    if (dispatchIds.length) {
      await sql`
        DELETE FROM dispatch_discrepancy_events
        WHERE discrepancy_id IN (
          SELECT id FROM dispatch_discrepancies
          WHERE dispatch_id = ANY(${dispatchIds}::uuid[])
        )
      `.execute(db);
      await sql`
        DELETE FROM dispatch_discrepancies
        WHERE dispatch_id = ANY(${dispatchIds}::uuid[])
      `.execute(db);
      await db
        .deleteFrom('dispatch_events')
        .where('dispatch_id', 'in', dispatchIds)
        .execute();
      if (stockItemIds.length) {
        await db
          .deleteFrom('inventory_movements')
          .where('stock_item_id', 'in', stockItemIds)
          .execute();
      }
      const receiptIds = await db
        .selectFrom('dispatch_receipts')
        .select('id')
        .where('dispatch_id', 'in', dispatchIds)
        .execute();
      if (receiptIds.length) {
        await db
          .deleteFrom('dispatch_receipt_items')
          .where(
            'dispatch_receipt_id',
            'in',
            receiptIds.map((receipt) => receipt.id),
          )
          .execute();
        await db
          .deleteFrom('dispatch_receipts')
          .where(
            'id',
            'in',
            receiptIds.map((receipt) => receipt.id),
          )
          .execute();
      }
      const closureIds = await db
        .selectFrom('dispatch_shortage_closures')
        .select('id')
        .where('dispatch_id', 'in', dispatchIds)
        .execute();
      if (closureIds.length) {
        await db
          .deleteFrom('dispatch_shortage_closure_items')
          .where(
            'shortage_closure_id',
            'in',
            closureIds.map((closure) => closure.id),
          )
          .execute();
        await db
          .deleteFrom('dispatch_shortage_closures')
          .where(
            'id',
            'in',
            closureIds.map((closure) => closure.id),
          )
          .execute();
      }
      await db
        .deleteFrom('dispatch_items')
        .where('dispatch_id', 'in', dispatchIds)
        .execute();
      await db
        .deleteFrom('dispatches')
        .where('id', 'in', dispatchIds)
        .execute();
    }
    if (stockItemIds.length) {
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
    if (branchIdsToDelete.length)
      await db
        .deleteFrom('branches')
        .where('id', 'in', branchIdsToDelete)
        .execute();
    if (userIdsToDelete.length)
      await db
        .deleteFrom('auth.users')
        .where('id', 'in', userIdsToDelete)
        .execute();
    await Promise.all([
      app.close(),
      guardedApp.close(),
      deniedPermissionApp.close(),
    ]);
  });

  it.each([
    { method: 'GET', path: '/dispatches' },
    {
      method: 'GET',
      path: '/dispatches/00000000-0000-4000-8000-000000000001',
    },
    { method: 'POST', path: '/dispatches' },
    {
      method: 'POST',
      path: '/dispatches/00000000-0000-4000-8000-000000000001/dispatch',
    },
    {
      method: 'POST',
      path: '/dispatches/00000000-0000-4000-8000-000000000001/receive',
    },
    {
      method: 'POST',
      path: '/dispatches/00000000-0000-4000-8000-000000000001/shortage-closures',
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

  it('denies a valid session without dispatch permission', async () => {
    const response = await request(deniedPermissionApp.getHttpServer()).get(
      '/dispatches',
    );
    expect(response.status).toBe(403);
    expect(response.body.message).toBe('Permission required');
  });

  it('validates idempotency keys, delivery names, unique count lines, and resolution input', async () => {
    const validPayload = dispatchPayload([
      { stock_item_id: stockItemIds[0], quantity_dispatched: '1' },
    ]);
    const create = await request(app.getHttpServer())
      .post('/dispatches')
      .send(validPayload);
    const invalidCreateKey = await request(app.getHttpServer())
      .post('/dispatches')
      .set('Idempotency-Key', 'invalid')
      .send(validPayload);
    const duplicateStockItem = await request(app.getHttpServer())
      .post('/dispatches')
      .set('Idempotency-Key', randomUUID())
      .send(
        dispatchPayload([
          { stock_item_id: stockItemIds[0], quantity_dispatched: '1' },
          { stock_item_id: stockItemIds[0], quantity_dispatched: '2' },
        ]),
      );
    const zeroDispatchQuantity = await request(app.getHttpServer())
      .post('/dispatches')
      .set('Idempotency-Key', randomUUID())
      .send(
        dispatchPayload([
          { stock_item_id: stockItemIds[0], quantity_dispatched: '0' },
        ]),
      );
    expect(create.status).toBe(400);
    expect(invalidCreateKey.status).toBe(400);
    expect(duplicateStockItem.status).toBe(400);
    expect(zeroDispatchQuantity.status).toBe(400);
    const blankDeliveryName = await request(app.getHttpServer())
      .post('/dispatches/send')
      .set('Idempotency-Key', randomUUID())
      .send({ ...validPayload, delivered_by_name: '   ' });
    const missingDeliveryName = await request(app.getHttpServer())
      .post('/dispatches/send')
      .set('Idempotency-Key', randomUUID())
      .send(validPayload);
    expect(blankDeliveryName.status).toBe(400);
    expect(missingDeliveryName.status).toBe(400);

    const invalidReceipt = await request(app.getHttpServer())
      .post(`/dispatches/${randomUUID()}/receive`)
      .set('Idempotency-Key', randomUUID())
      .send({
        items: [{ dispatch_item_id: randomUUID(), quantity_received: '-1' }],
      });
    const duplicateItemId = randomUUID();
    const duplicateReceiptLines = await request(app.getHttpServer())
      .post(`/dispatches/${randomUUID()}/receive`)
      .set('Idempotency-Key', randomUUID())
      .send({
        items: [
          { dispatch_item_id: duplicateItemId, quantity_received: '1' },
          { dispatch_item_id: duplicateItemId, quantity_received: '2' },
        ],
      });
    const blankReason = await request(app.getHttpServer())
      .post(`/dispatches/${randomUUID()}/shortage-closures`)
      .set('Idempotency-Key', randomUUID())
      .send({
        outcome: 'LOST',
        reason: '   ',
        items: [{ dispatch_item_id: randomUUID(), quantity_closed: '1' }],
      });
    const missingOutcome = await request(app.getHttpServer())
      .post(`/dispatches/${randomUUID()}/shortage-closures`)
      .set('Idempotency-Key', randomUUID())
      .send({
        reason: 'Outcome is required.',
        items: [{ dispatch_item_id: randomUUID(), quantity_closed: '1' }],
      });
    expect(invalidReceipt.status).toBe(400);
    expect(duplicateReceiptLines.status).toBe(400);
    expect(blankReason.status).toBe(400);
    expect(missingOutcome.status).toBe(400);
  });

  it('returns the same draft for concurrent retries with one idempotency key', async () => {
    const payload = dispatchPayload([
      { stock_item_id: stockItemIds[0], quantity_dispatched: '2' },
    ]);
    const idempotencyKey = randomUUID();
    const responses = await Promise.all(
      Array.from({ length: 12 }, () =>
        request(app.getHttpServer())
          .post('/dispatches')
          .set('Idempotency-Key', idempotencyKey)
          .send(payload),
      ),
    );
    const createdIds = responses
      .filter((response) => response.status === 201)
      .map((response) => response.body.id as string);
    dispatchIds.push(...new Set(createdIds));

    expect(responses.map((response) => response.status)).toEqual(
      Array.from({ length: 12 }, () => 201),
    );
    expect(new Set(createdIds).size).toBe(1);
    expect(responses[0].body.items[0].quantity_in_transit).toBe('0');
  });

  it('sends a draft with a delivery name, takes one blind count, and returns unloaded stock to the commissary', async () => {
    const [flourId, oilId] = stockItemIds;
    await setCommissaryBalance(flourId, '20');
    await setCommissaryBalance(oilId, '4.25');
    const created = await request(app.getHttpServer())
      .post('/dispatches')
      .set('Idempotency-Key', randomUUID())
      .send(
        dispatchPayload([
          { stock_item_id: flourId, quantity_dispatched: '10.5' },
          { stock_item_id: oilId, quantity_dispatched: '2.25' },
        ]),
      );
    expect(created.status).toBe(201);
    dispatchIds.push(created.body.id);

    const unnamed = await request(app.getHttpServer())
      .post(`/dispatches/${created.body.id}/dispatch`)
      .set('Idempotency-Key', randomUUID())
      .send({});
    expect(unnamed.status).toBe(400);
    const dispatchKey = randomUUID();
    const postDispatch = () =>
      request(app.getHttpServer())
        .post(`/dispatches/${created.body.id}/dispatch`)
        .set('Idempotency-Key', dispatchKey)
        .send({ delivered_by_name: 'Juan Dela Cruz' });
    const [dispatched, retryDispatch] = await Promise.all([
      postDispatch(),
      postDispatch(),
    ]);
    expect(dispatched.status).toBe(201);
    expect(retryDispatch.status).toBe(201);
    expect(retryDispatch.body.id).toBe(dispatched.body.id);
    expect(dispatched.body).toMatchObject({
      status: 'IN_TRANSIT',
      delivered_by_name: 'Juan Dela Cruz',
      counted_at: null,
    });
    expect(await commissaryBalance(flourId)).toBe('9.5');
    expect(await commissaryBalance(oilId)).toBe('2');

    const lines = dispatched.body.items as Array<{
      id: string;
      stock_item_id: string;
    }>;
    const flour = lines.find((line) => line.stock_item_id === flourId)!;
    const oil = lines.find((line) => line.stock_item_id === oilId)!;
    const count = (key: string, body: object) =>
      request(app.getHttpServer())
        .post(`/dispatches/${created.body.id}/receive`)
        .set('Idempotency-Key', key)
        .send(body);
    const exactBody = {
      items: [
        { dispatch_item_id: flour.id, quantity_received: '10.5' },
        { dispatch_item_id: oil.id, quantity_received: '2.25' },
      ],
    };
    expect((await count(randomUUID(), exactBody)).status).toBe(403);

    currentUserId = receiverUserId;
    try {
      const missingLine = await count(randomUUID(), {
        items: [{ dispatch_item_id: flour.id, quantity_received: '10.5' }],
      });
      expect(missingLine.status).toBe(400);
      const countKey = randomUUID();
      const countBody = {
        items: [
          { dispatch_item_id: flour.id, quantity_received: '10.5000' },
          { dispatch_item_id: oil.id, quantity_received: '2' },
        ],
        note: 'One oil container was missing.',
      };
      const [counted, retryCount] = await Promise.all([
        count(countKey, countBody),
        count(countKey, countBody),
      ]);
      expect(counted.status).toBe(201);
      expect(retryCount.status).toBe(201);
      expect(counted.body).toMatchObject({
        status: 'PARTIALLY_RECEIVED',
        counted_by_user_id: receiverUserId,
        discrepancy: { status: 'OPEN' },
      });
      const byStock = (body: {
        items: Array<Record<string, string> & { stock_item_id: string }>;
      }) =>
        [flourId, oilId].map((stockId) => {
          const item = body.items.find((line) => line.stock_item_id === stockId)!;
          return [
            item.quantity_received,
            item.quantity_variance,
            item.quantity_in_transit,
            item.quantity_outstanding,
          ];
        });
      expect(byStock(counted.body)).toEqual([
        ['10.5', '0', '0', '0'],
        ['2', '-0.25', '0', '0.25'],
      ]);
      expect(counted.body.discrepancy_events[0].note).toBe(
        'One oil container was missing.',
      );
      expect(await branchBalance(branchId, flourId)).toBe('10.5');
      expect(await branchBalance(branchId, oilId)).toBe('2');
      expect(
        (await count(countKey, { ...countBody, note: 'Changed' })).status,
      ).toBe(409);
      expect((await count(randomUUID(), exactBody)).status).toBe(409);
      const counterResolves = await request(app.getHttpServer())
        .post(`/dispatches/${created.body.id}/shortage-closures`)
        .set('Idempotency-Key', randomUUID())
        .send({
          outcome: 'LOST',
          reason: 'Counter cannot resolve their own count.',
          items: [{ dispatch_item_id: oil.id, quantity_closed: '0.25' }],
        });
      expect(counterResolves.status).toBe(403);
    } finally {
      currentUserId = actorUserId;
    }

    const resolve = (outcome: string, quantity: string) =>
      request(app.getHttpServer())
        .post(`/dispatches/${created.body.id}/shortage-closures`)
        .set('Idempotency-Key', randomUUID())
        .send({
          outcome,
          reason: 'Container was left at the commissary.',
          items: [{ dispatch_item_id: oil.id, quantity_closed: quantity }],
        });
    expect((await resolve('SURPLUS', '0.25')).status).toBe(400);
    expect((await resolve('NOT_LOADED', '0.5')).status).toBe(400);
    const resolved = await resolve('NOT_LOADED', '0.25');
    expect(resolved.status).toBe(201);
    expect(resolved.body).toMatchObject({
      status: 'CLOSED_WITH_SHORTAGE',
      discrepancy: { status: 'RESOLVED' },
      shortage_closures: [{ outcome: 'NOT_LOADED' }],
    });
    expect(await commissaryBalance(oilId)).toBe('2.25');
    expect(await branchBalance(branchId, oilId)).toBe('2');
    const returned = await db
      .selectFrom('inventory_movements')
      .select(['movement_type', 'quantity_delta'])
      .where('stock_item_id', '=', oilId)
      .where('dispatch_shortage_closure_item_id', 'is not', null)
      .execute();
    expect(
      returned.map((row) => [row.movement_type, normalizeDecimal(String(row.quantity_delta))]),
    ).toEqual([['DISPATCH_RETURN', '0.25']]);
    expect((await resolve('LOST', '0.25')).status).toBe(409);
    expect(
      resolved.body.events.map(
        (event: { event_type: string }) => event.event_type,
      ),
    ).toEqual(['CREATED', 'DISPATCHED', 'RECEIPT_RECORDED', 'SHORTAGE_CLOSED']);
  });

  it('keeps a draft intact when stock is insufficient and enforces branch scope', async () => {
    const payload = dispatchPayload([
      { stock_item_id: stockItemIds[1], quantity_dispatched: '500' },
    ]);
    const created = await request(app.getHttpServer())
      .post('/dispatches')
      .set('Idempotency-Key', randomUUID())
      .send(payload);
    expect(created.status).toBe(201);
    dispatchIds.push(created.body.id);
    const before = await movementCount(stockItemIds);
    const insufficient = await request(app.getHttpServer())
      .post(`/dispatches/${created.body.id}/dispatch`)
      .set('Idempotency-Key', randomUUID())
      .send({ delivered_by_name: 'Test courier' });
    const stillDraft = await db
      .selectFrom('dispatches')
      .select('status')
      .where('id', '=', created.body.id)
      .executeTakeFirstOrThrow();
    expect(insufficient.status).toBe(400);
    expect(stillDraft.status).toBe('DRAFT');
    expect(await movementCount(stockItemIds)).toBe(before);

    branchIds = [otherBranchId];
    const outOfScopeCreate = await request(app.getHttpServer())
      .post('/dispatches')
      .set('Idempotency-Key', randomUUID())
      .send(
        dispatchPayload(
          [{ stock_item_id: stockItemIds[0], quantity_dispatched: '1' }],
          branchId,
        ),
      );
    const outOfScopeFilter = await request(app.getHttpServer()).get(
      `/dispatches?branch_id=${branchId}`,
    );
    expect(outOfScopeCreate.status).toBe(403);
    expect(outOfScopeFilter.status).toBe(403);
    branchIds = [branchId];
  });

  it('hides expected quantities until counted, records zero and surplus lines, and confirms surplus against commissary stock', async () => {
    const [flourId, oilId] = stockItemIds;
    await setCommissaryBalance(flourId, '50');
    await setCommissaryBalance(oilId, '50');
    const sent = await request(app.getHttpServer())
      .post('/dispatches/send')
      .set('Idempotency-Key', randomUUID())
      .send(
        sendPayload([
          { stock_item_id: flourId, quantity_dispatched: '5' },
          { stock_item_id: oilId, quantity_dispatched: '3' },
        ]),
      );
    expect(sent.status).toBe(201);
    dispatchIds.push(sent.body.id);
    const lines = sent.body.items as Array<{ id: string; stock_item_id: string }>;
    const flour = lines.find((line) => line.stock_item_id === flourId)!;
    const oil = lines.find((line) => line.stock_item_id === oilId)!;
    const flourBefore = await optionalBranchBalance(branchId, flourId);

    const originalPermissions = sendPermissions;
    currentUserId = receiverUserId;
    sendPermissions = ['dispatches.read', 'dispatches.receive'];
    try {
      const hidden = await request(app.getHttpServer()).get(
        `/dispatches/${sent.body.id}`,
      );
      expect(hidden.status).toBe(200);
      expect(
        hidden.body.items.every(
          (item: Record<string, unknown>) =>
            item.quantity_dispatched === null &&
            item.quantity_in_transit === null &&
            item.quantity_outstanding === null &&
            item.awaiting_count === true,
        ),
      ).toBe(true);
      const counted = await request(app.getHttpServer())
        .post(`/dispatches/${sent.body.id}/receive`)
        .set('Idempotency-Key', randomUUID())
        .send({
          items: [
            { dispatch_item_id: flour.id, quantity_received: '6' },
            { dispatch_item_id: oil.id, quantity_received: '0' },
          ],
        });
      expect(counted.status).toBe(201);
      expect(counted.body.status).toBe('PARTIALLY_RECEIVED');
      expect(counted.body.discrepancy.status).toBe('OPEN');
      expect(counted.body.discrepancy_events[0].note).toBe(
        'The branch count differs from the dispatched quantities.',
      );
      const visible = await request(app.getHttpServer()).get(
        `/dispatches/${sent.body.id}`,
      );
      expect(
        visible.body.items.find(
          (item: { stock_item_id: string }) => item.stock_item_id === flourId,
        ),
      ).toMatchObject({ quantity_dispatched: '5', quantity_variance: '1' });
    } finally {
      sendPermissions = originalPermissions;
      currentUserId = actorUserId;
    }
    expect(await branchBalance(branchId, flourId)).toBe(
      String(Number(flourBefore) + 6),
    );
    const zeroMovements = await db
      .selectFrom('inventory_movements as im')
      .innerJoin(
        'dispatch_receipt_items as dri',
        'dri.id',
        'im.dispatch_receipt_item_id',
      )
      .select('im.id')
      .where('dri.dispatch_item_id', '=', oil.id)
      .execute();
    expect(zeroMovements).toHaveLength(0);

    const resolve = (outcome: string, itemId: string, quantity: string) =>
      request(app.getHttpServer())
        .post(`/dispatches/${sent.body.id}/shortage-closures`)
        .set('Idempotency-Key', randomUUID())
        .send({
          outcome,
          reason: 'Reviewed with the branch and the courier.',
          items: [{ dispatch_item_id: itemId, quantity_closed: quantity }],
        });
    expect((await resolve('NOT_LOADED', flour.id, '1')).status).toBe(400);
    await setCommissaryBalance(flourId, '0.5');
    expect((await resolve('SURPLUS', flour.id, '1')).status).toBe(409);
    await setCommissaryBalance(flourId, '45');
    const surplus = await resolve('SURPLUS', flour.id, '1');
    expect(surplus.status).toBe(201);
    expect(surplus.body.status).toBe('PARTIALLY_RECEIVED');
    expect(await commissaryBalance(flourId)).toBe('44');
    const lost = await resolve('LOST', oil.id, '3');
    expect(lost.status).toBe(201);
    expect(lost.body).toMatchObject({
      status: 'CLOSED_WITH_SHORTAGE',
      discrepancy: { status: 'RESOLVED' },
    });
    expect(
      lost.body.discrepancy_events.map(
        (event: { event_type: string }) => event.event_type,
      ),
    ).toEqual(['REPORTED', 'RESOLVED_SHORTAGE']);
    expect(await commissaryBalance(oilId)).toBe('47');

    for (const path of ['discrepancies', 'discrepancies/recount'])
      expect(
        (
          await request(app.getHttpServer())
            .post(`/dispatches/${sent.body.id}/${path}`)
            .set('Idempotency-Key', randomUUID())
            .send({ note: 'Retired route', reason: 'Retired route' })
        ).status,
      ).toBe(404);
  });

  it('sends multiple exact decimal lines atomically and replays concurrent requests after receipt', async () => {
    await setCommissaryBalance(stockItemIds[0], '10');
    await setCommissaryBalance(stockItemIds[1], '5');
    const key = randomUUID();
    const payload = sendPayload([
      { stock_item_id: stockItemIds[0], quantity_dispatched: '002.5000' },
      { stock_item_id: stockItemIds[1], quantity_dispatched: '1.125' },
    ]);
    const send = () =>
      request(app.getHttpServer())
        .post('/dispatches/send')
        .set('Idempotency-Key', key)
        .send(payload);
    const responses = await Promise.all([send(), send(), send()]);
    expect(responses.map((r) => r.status)).toEqual([201, 201, 201]);
    const dispatched = responses[0].body;
    dispatchIds.push(dispatched.id);
    expect(new Set(responses.map((r) => r.body.id)).size).toBe(1);
    expect(dispatched.status).toBe('IN_TRANSIT');
    expect(dispatched.created_by_user_id).toBe(actorUserId);
    expect(dispatched.dispatched_by_user_id).toBe(actorUserId);
    expect(dispatched.delivered_by_name).toBe('Test courier');
    expect(dispatched.dispatched_at).toBeTruthy();
    expect(
      dispatched.events.filter(
        (event: { event_type: string }) => event.event_type === 'DISPATCHED',
      ),
    ).toHaveLength(1);
    expect(await commissaryBalance(stockItemIds[0])).toBe('7.5');
    expect(await commissaryBalance(stockItemIds[1])).toBe('3.875');
    const movements = await db
      .selectFrom('inventory_movements')
      .selectAll()
      .where(
        'dispatch_item_id',
        'in',
        dispatched.items.map((line: { id: string }) => line.id),
      )
      .execute();
    expect(movements).toHaveLength(2);
    expect(movements.map((line) => line.quantity_delta).sort()).toEqual([
      '-1.125',
      '-2.5',
    ]);
    const exact = dispatched.items.map(
      (line: { id: string; quantity_dispatched: string }) => ({
        dispatch_item_id: line.id,
        quantity_received: line.quantity_dispatched,
      }),
    );
    currentUserId = receiverUserId;
    try {
      const counted = await request(app.getHttpServer())
        .post(`/dispatches/${dispatched.id}/receive`)
        .set('Idempotency-Key', randomUUID())
        .send({ items: exact });
      expect(counted.status).toBe(201);
      expect(counted.body.status).toBe('RECEIVED');
      expect(counted.body.discrepancy).toBeNull();
    } finally {
      currentUserId = actorUserId;
    }
    expect((await send()).body.status).toBe('RECEIVED');
    expect(await commissaryBalance(stockItemIds[0])).toBe('7.5');
    expect(await commissaryBalance(stockItemIds[1])).toBe('3.875');
    expect(
      (
        await request(app.getHttpServer())
          .post('/dispatches/send')
          .set('Idempotency-Key', key)
          .send({
            ...payload,
            items: [
              { stock_item_id: stockItemIds[0], quantity_dispatched: '3' },
            ],
          })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(app.getHttpServer())
          .post('/dispatches/send')
          .set('Idempotency-Key', key)
          .send({ ...payload, delivered_by_name: 'Someone else' })
      ).status,
    ).toBe(409);
    currentUserId = deniedUserId;
    expect((await send()).status).toBe(409);
    currentUserId = actorUserId;
    expect(
      (
        await request(app.getHttpServer())
          .post('/dispatches')
          .set('Idempotency-Key', key)
          .send({ branch_id: payload.branch_id, items: payload.items })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(app.getHttpServer())
          .post(`/dispatches/${dispatched.id}/dispatch`)
          .set('Idempotency-Key', key)
          .send({ delivered_by_name: 'Test courier' })
      ).status,
    ).toBe(409);
  });

  it('rolls back all lines and the record when any balance is insufficient', async () => {
    await setCommissaryBalance(stockItemIds[0], '10');
    await setCommissaryBalance(stockItemIds[1], '0');
    const before = await movementCount(stockItemIds);
    const key = randomUUID();
    const response = await request(app.getHttpServer())
      .post('/dispatches/send')
      .set('Idempotency-Key', key)
      .send(
        sendPayload(
          stockItemIds.map((stock_item_id) => ({
            stock_item_id,
            quantity_dispatched: '1',
          })),
        ),
      );
    expect(response.status).toBe(400);
    expect(response.body.message).toContain('Dispatch oil');
    expect(await commissaryBalance(stockItemIds[0])).toBe('10');
    expect(await commissaryBalance(stockItemIds[1])).toBe('0');
    expect(await movementCount(stockItemIds)).toBe(before);
    expect(
      await db
        .selectFrom('dispatches')
        .select('id')
        .where('idempotency_key', '=', key)
        .execute(),
    ).toHaveLength(0);
    expect(
      await db
        .selectFrom('dispatch_events')
        .select('id')
        .where('idempotency_key', '=', key)
        .execute(),
    ).toHaveLength(0);
  });

  it('rejects inactive branches/items and unassigned branches without saved dispatches', async () => {
    const before = await db.selectFrom('dispatches').select('id').execute();
    const beforeMovements = await movementCount(stockItemIds);
    const payload = sendPayload([
      { stock_item_id: stockItemIds[0], quantity_dispatched: '1' },
    ]);
    const send = (body = payload) =>
      request(app.getHttpServer())
        .post('/dispatches/send')
        .set('Idempotency-Key', randomUUID())
        .send(body);
    expect((await send({ ...payload, branch_id: otherBranchId })).status).toBe(
      403,
    );
    const missingBranch = randomUUID();
    const originalBranches = branchIds;
    branchIds = [missingBranch];
    try {
      expect(
        (await send({ ...payload, branch_id: missingBranch })).status,
      ).toBe(404);
    } finally {
      branchIds = originalBranches;
    }
    expect(
      (
        await send({
          ...payload,
          items: [{ stock_item_id: randomUUID(), quantity_dispatched: '1' }],
        })
      ).status,
    ).toBe(404);
    await db
      .updateTable('branches')
      .set({ status: 'inactive' })
      .where('id', '=', branchId)
      .execute();
    expect((await send()).status).toBe(404);
    await db
      .updateTable('branches')
      .set({ status: 'active' })
      .where('id', '=', branchId)
      .execute();
    await db
      .updateTable('stock_items')
      .set({ is_active: false })
      .where('id', '=', stockItemIds[0])
      .execute();
    expect((await send()).status).toBe(404);
    await db
      .updateTable('stock_items')
      .set({ is_active: true })
      .where('id', '=', stockItemIds[0])
      .execute();
    expect(
      await db.selectFrom('dispatches').select('id').execute(),
    ).toHaveLength(before.length);
    expect(await movementCount(stockItemIds)).toBe(beforeMovements);
  });

  it.each(['dispatches.create', 'dispatches.dispatch'] as const)(
    'rejects sending without %s',
    async (permission) => {
      const original = sendPermissions;
      sendPermissions = original.filter((item) => item !== permission);
      const key = randomUUID();
      try {
        expect(
          (
            await request(app.getHttpServer())
              .post('/dispatches/send')
              .set('Idempotency-Key', key)
              .send(
                sendPayload([
                  { stock_item_id: stockItemIds[0], quantity_dispatched: '1' },
                ]),
              )
          ).status,
        ).toBe(403);
        expect(
          await db
            .selectFrom('dispatches')
            .select('id')
            .where('idempotency_key', '=', key)
            .execute(),
        ).toHaveLength(0);
      } finally {
        sendPermissions = original;
      }
    },
  );

  it('allows only one concurrent dispatch to consume limited stock', async () => {
    await setCommissaryBalance(stockItemIds[0], '3');
    const before = await movementCount([stockItemIds[0]]);
    const responses = await Promise.all(
      [1, 2].map(() =>
        request(app.getHttpServer())
          .post('/dispatches/send')
          .set('Idempotency-Key', randomUUID())
          .send(
            sendPayload([
              { stock_item_id: stockItemIds[0], quantity_dispatched: '2' },
            ]),
          ),
      ),
    );
    expect(responses.map((r) => r.status).sort((a, b) => a - b)).toEqual([
      201, 400,
    ]);
    dispatchIds.push(responses.find((r) => r.status === 201)!.body.id);
    expect(await commissaryBalance(stockItemIds[0])).toBe('1');
    expect(await movementCount([stockItemIds[0]])).toBe(before + 1);
  });

  it('sends reversed item lines while another branch creates a legacy draft without a lock cycle', async () => {
    const [first, second] = [...stockItemIds].sort();
    await setCommissaryBalance(first, '10');
    await setCommissaryBalance(second, '10');
    const originalBranches = branchIds;
    branchIds = [branchId, otherBranchId];
    // Pause after the first FK check to force the formerly unsafe interleaving.
    await sql`
      CREATE FUNCTION dispatch_test_pause() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.stock_item_id = ${sql.lit(second)}::uuid THEN
          PERFORM pg_sleep(1);
        END IF;
        RETURN NEW;
      END $$
    `.execute(db);
    await sql`CREATE TRIGGER zz_dispatch_test_pause AFTER INSERT ON dispatch_items
      FOR EACH ROW EXECUTE FUNCTION dispatch_test_pause()`.execute(db);
    const payload = sendPayload([
      { stock_item_id: second, quantity_dispatched: '2' },
      { stock_item_id: first, quantity_dispatched: '2' },
    ]);
    try {
      const sending = request(app.getHttpServer())
        .post('/dispatches/send')
        .set('Idempotency-Key', randomUUID())
        .send(payload)
        .then((response) => response);
      const deadline = Date.now() + 4000;
      let paused = false;
      while (!paused && Date.now() < deadline) {
        const state = await sql<{ paused: boolean }>`
          SELECT EXISTS (SELECT 1 FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event = 'PgSleep'
            AND query LIKE 'insert into "dispatch_items"%') AS paused
        `.execute(db);
        paused = state.rows[0].paused;
        if (!paused) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(paused).toBe(true);
      const drafting = request(app.getHttpServer())
        .post('/dispatches')
        .set('Idempotency-Key', randomUUID())
        .send({ branch_id: otherBranchId, items: payload.items });
      const responses = await Promise.all([sending, drafting]);
      dispatchIds.push(
        ...responses.filter((r) => r.status === 201).map((r) => r.body.id),
      );
      expect(responses.map((r) => r.status)).toEqual([201, 201]);
      expect(responses[0].body.status).toBe('IN_TRANSIT');
      expect(
        responses[1].body.items.every(
          (line: { quantity_in_transit: string }) =>
            line.quantity_in_transit === '0',
        ),
      ).toBe(true);
      expect(await commissaryBalance(first)).toBe('8');
      expect(await commissaryBalance(second)).toBe('8');
    } finally {
      branchIds = originalBranches;
      await sql`DROP TRIGGER IF EXISTS zz_dispatch_test_pause ON dispatch_items`.execute(
        db,
      );
      await sql`DROP FUNCTION IF EXISTS dispatch_test_pause()`.execute(db);
    }
  });

  it('conflicts concurrent cross-action keys across branches without a lock cycle', async () => {
    await setCommissaryBalance(stockItemIds[0], '10');
    const originalBranches = branchIds;
    branchIds = [branchId, otherBranchId];
    const key = randomUUID();
    await sql`CREATE FUNCTION dispatch_test_key_pause() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.idempotency_key = ${sql.lit(key)}::uuid THEN PERFORM pg_sleep(1); END IF;
        RETURN NEW;
      END $$`.execute(db);
    await sql`CREATE TRIGGER zz_dispatch_test_key_pause AFTER INSERT ON dispatches
      FOR EACH ROW EXECUTE FUNCTION dispatch_test_key_pause()`.execute(db);
    const payload = sendPayload([
      { stock_item_id: stockItemIds[0], quantity_dispatched: '2' },
    ]);
    try {
      const sending = request(app.getHttpServer())
        .post('/dispatches/send')
        .set('Idempotency-Key', key)
        .send(payload)
        .then((response) => response);
      const deadline = Date.now() + 4000;
      let paused = false;
      while (!paused && Date.now() < deadline) {
        const state = await sql<{ paused: boolean }>`SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
          AND wait_event = 'PgSleep' AND query LIKE 'insert into "dispatches"%'
        ) AS paused`.execute(db);
        paused = state.rows[0].paused;
        if (!paused) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(paused).toBe(true);
      const drafting = request(app.getHttpServer())
        .post('/dispatches')
        .set('Idempotency-Key', key)
        .send({ branch_id: otherBranchId, items: payload.items });
      const responses = await Promise.all([sending, drafting]);
      dispatchIds.push(
        ...responses.filter((r) => r.status === 201).map((r) => r.body.id),
      );
      expect(responses.map((r) => r.status)).toEqual([201, 409]);
      expect(await commissaryBalance(stockItemIds[0])).toBe('8');
    } finally {
      branchIds = originalBranches;
      await sql`DROP TRIGGER IF EXISTS zz_dispatch_test_key_pause ON dispatches`.execute(
        db,
      );
      await sql`DROP FUNCTION IF EXISTS dispatch_test_key_pause()`.execute(db);
    }
  });

  it('searches and sorts branch names within the authorized dispatch scope', async () => {
    const originalBranches = branchIds;
    const a = await createBranch(`Directory A ${suffix}`);
    const z = await createBranch(`Directory Z ${suffix}`);
    for (const id of [z, a]) {
      const row = await db
        .insertInto('dispatches')
        .values({
          branch_id: id,
          created_by_user_id: actorUserId,
          status: 'DRAFT',
          idempotency_key: randomUUID(),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      dispatchIds.push(row.id);
    }
    branchIds = [a, z];
    try {
      const result = await request(app.getHttpServer())
        .get('/dispatches')
        .query({
          search: `Directory ${' '}`,
          sort: 'branch_asc',
          page_size: 1,
        });
      expect(result.status).toBe(200);
      expect(result.body.total).toBe(2);
      expect(result.body.items[0].branch_id).toBe(a);
      const descending = await request(app.getHttpServer())
        .get('/dispatches')
        .query({ search: 'Directory', sort: 'branch_desc', page_size: 1 });
      expect(descending.body.items[0].branch_id).toBe(z);
      branchIds = [a];
      const scoped = await request(app.getHttpServer())
        .get('/dispatches')
        .query({ search: 'Directory', sort: 'branch_desc' });
      expect(scoped.body.total).toBe(1);
      expect(scoped.body.items[0].branch_id).toBe(a);
    } finally {
      branchIds = originalBranches;
    }
  });

  it('paginates dispatches in SQL with a default of 10 and configurable sizes', async () => {
    const originalBranches = branchIds;
    const branch = await createBranch(`Pagination ${suffix}`);
    const excluded = await createBranch(`Pagination excluded ${suffix}`);
    const rows = await db
      .insertInto('dispatches')
      .values(
        Array.from({ length: 66 }, (_, index) => ({
          branch_id: index === 65 ? excluded : branch,
          created_by_user_id: actorUserId,
          status: 'DRAFT' as const,
          idempotency_key: randomUUID(),
        })),
      )
      .returning('id')
      .execute();
    dispatchIds.push(...rows.map((row) => row.id));
    branchIds = [branch];
    try {
      const query = { search: 'Pagination', status: 'DRAFT', sort: 'oldest' };
      const first = await request(app.getHttpServer())
        .get('/dispatches')
        .query(query);
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({ total: 65, page: 1, page_size: 10 });
      expect(first.body.items).toHaveLength(10);
      for (const size of [10, 20, 30, 50]) {
        const result = await request(app.getHttpServer())
          .get('/dispatches')
          .query({ ...query, page_size: size });
        expect(result.status).toBe(200);
        expect(result.body.items).toHaveLength(size);
        expect(result.body.total).toBe(65);
        expect(
          result.body.items.every(
            (row: { branch_id: string }) => row.branch_id === branch,
          ),
        ).toBe(true);
      }
      const second = await request(app.getHttpServer())
        .get('/dispatches')
        .query({ ...query, page: 2 });
      expect(second.body.items).toHaveLength(10);
      const firstIds = new Set(
        first.body.items.map((row: { id: string }) => row.id),
      );
      expect(
        second.body.items.every((row: { id: string }) => !firstIds.has(row.id)),
      ).toBe(true);
      const last = await request(app.getHttpServer())
        .get('/dispatches')
        .query({ ...query, page_size: 30, page: 3 });
      expect(last.body.items).toHaveLength(5);
      expect(last.body).toMatchObject({ total: 65, page: 3, page_size: 30 });
      const empty = await request(app.getHttpServer())
        .get('/dispatches')
        .query({ ...query, page: 100 });
      expect(empty.body.items).toHaveLength(0);
      expect(empty.body.total).toBe(65);
    } finally {
      branchIds = originalBranches;
    }
  });

  async function createBranch(name: string): Promise<string> {
    const branch = await db
      .insertInto('branches')
      .values({
        code: `DP-${randomUUID().slice(0, 8)}`,
        branch_name: name,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    branchIdsToDelete.push(branch.id);
    return branch.id;
  }

  async function createStockItem(name: string): Promise<string> {
    const item = await db
      .insertInto('stock_items')
      .values({ stock_item_name: name, category: 'Test', unit: 'kg' })
      .returning('id')
      .executeTakeFirstOrThrow();
    return item.id;
  }

  function dispatchPayload(
    items: Array<{ stock_item_id: string; quantity_dispatched: string }>,
    targetBranchId = branchId,
  ) {
    return { branch_id: targetBranchId, items };
  }

  function sendPayload(
    items: Array<{ stock_item_id: string; quantity_dispatched: string }>,
    targetBranchId = branchId,
  ) {
    return {
      ...dispatchPayload(items, targetBranchId),
      delivered_by_name: 'Test courier',
    };
  }

  async function setCommissaryBalance(stockItemId: string, quantity: string) {
    await db
      .insertInto('commissary_inventory')
      .values({ stock_item_id: stockItemId, quantity_on_hand: quantity })
      .onConflict((conflict) =>
        conflict.column('stock_item_id').doUpdateSet({
          quantity_on_hand: quantity,
        }),
      )
      .execute();
  }

  async function commissaryBalance(stockItemId: string): Promise<string> {
    const balance = await db
      .selectFrom('commissary_inventory')
      .select('quantity_on_hand')
      .where('stock_item_id', '=', stockItemId)
      .executeTakeFirstOrThrow();
    return normalizeDecimal(String(balance.quantity_on_hand));
  }

  async function branchBalance(
    targetBranchId: string,
    stockItemId: string,
  ): Promise<string> {
    const balance = await db
      .selectFrom('branch_inventory')
      .select('quantity_on_hand')
      .where('branch_id', '=', targetBranchId)
      .where('stock_item_id', '=', stockItemId)
      .executeTakeFirstOrThrow();
    return normalizeDecimal(String(balance.quantity_on_hand));
  }

  async function optionalBranchBalance(
    targetBranchId: string,
    stockItemId: string,
  ): Promise<string> {
    const balance = await db
      .selectFrom('branch_inventory')
      .select('quantity_on_hand')
      .where('branch_id', '=', targetBranchId)
      .where('stock_item_id', '=', stockItemId)
      .executeTakeFirst();
    return balance ? normalizeDecimal(String(balance.quantity_on_hand)) : '0';
  }

  async function movementCount(targetStockItemIds: string[]): Promise<number> {
    const result = await db
      .selectFrom('inventory_movements')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('stock_item_id', 'in', targetStockItemIds)
      .executeTakeFirstOrThrow();
    return Number(result.count);
  }

  function normalizeDecimal(value: string): string {
    const [wholePart, fractionPart = ''] = value.split('.');
    const whole = wholePart.replace(/^0+(?=\d)/, '');
    const fraction = fractionPart.replace(/0+$/, '');
    return `${whole}${fraction ? `.${fraction}` : ''}`;
  }
});
