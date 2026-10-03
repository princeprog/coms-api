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

  it('validates idempotency keys, positive unique receipt lines, and shortage reasons', async () => {
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

    const invalidReceipt = await request(app.getHttpServer())
      .post(`/dispatches/${randomUUID()}/receive`)
      .set('Idempotency-Key', randomUUID())
      .send({
        items: [{ dispatch_item_id: randomUUID(), quantity_received: '0' }],
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
        reason: '   ',
        items: [{ dispatch_item_id: randomUUID(), quantity_closed: '1' }],
      });
    expect(invalidReceipt.status).toBe(400);
    expect(duplicateReceiptLines.status).toBe(400);
    expect(blankReason.status).toBe(400);
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
  });

  it('dispatches approved quantities atomically, supports concurrent retries and partial receipts, then closes a shortage', async () => {
    const firstItemId = stockItemIds[0];
    const secondItemId = stockItemIds[1];
    await setCommissaryBalance(firstItemId, '20');
    await setCommissaryBalance(secondItemId, '4.25');
    const createPayload = dispatchPayload([
      { stock_item_id: firstItemId, quantity_dispatched: '10.5' },
      { stock_item_id: secondItemId, quantity_dispatched: '2.25' },
    ]);
    const createKey = randomUUID();
    const created = await request(app.getHttpServer())
      .post('/dispatches')
      .set('Idempotency-Key', createKey)
      .send(createPayload);
    expect(created.status).toBe(201);
    dispatchIds.push(created.body.id);
    expect(created.body).toMatchObject({
      branch_id: branchId,
      status: 'DRAFT',
      created_by_user_id: actorUserId,
    });
    expect(
      created.body.items.map(
        (item: { quantity_dispatched: string }) => item.quantity_dispatched,
      ),
    ).toEqual(['10.5', '2.25']);
    const retryCreate = await request(app.getHttpServer())
      .post('/dispatches')
      .set('Idempotency-Key', createKey)
      .send(createPayload);
    expect(retryCreate.status).toBe(201);
    expect(retryCreate.body.id).toBe(created.body.id);

    const beforeDispatchMovements = await movementCount(stockItemIds);
    expect(beforeDispatchMovements).toBe(0);
    const dispatchKey = randomUUID();
    const postDispatch = () =>
      request(app.getHttpServer())
        .post(`/dispatches/${created.body.id}/dispatch`)
        .set('Idempotency-Key', dispatchKey)
        .send({});
    const [dispatched, retryDispatch] = await Promise.all([
      postDispatch(),
      postDispatch(),
    ]);
    expect(dispatched.status).toBe(201);
    expect(retryDispatch.status).toBe(201);
    expect(dispatched.body.status).toBe('IN_TRANSIT');
    expect(retryDispatch.body.id).toBe(dispatched.body.id);
    expect(String(await commissaryBalance(firstItemId))).toBe('9.5');
    expect(String(await commissaryBalance(secondItemId))).toBe('2');
    expect(await movementCount(stockItemIds)).toBe(2);

    const [firstDispatchItem, secondDispatchItem] = dispatched.body
      .items as Array<{
      id: string;
    }>;
    const firstReceiptKey = randomUUID();
    const firstReceiptPayload = {
      items: [
        {
          dispatch_item_id: firstDispatchItem.id,
          quantity_received: '4.2500',
        },
        {
          dispatch_item_id: secondDispatchItem.id,
          quantity_received: '1.0000',
        },
      ],
    };
    const postReceipt = () =>
      request(app.getHttpServer())
        .post(`/dispatches/${created.body.id}/receive`)
        .set('Idempotency-Key', firstReceiptKey)
        .send(firstReceiptPayload);
    const [received, retryReceipt] = await Promise.all([
      postReceipt(),
      postReceipt(),
    ]);
    expect(received.status).toBe(201);
    expect(retryReceipt.status).toBe(201);
    expect(received.body.status).toBe('PARTIALLY_RECEIVED');
    expect(String(await branchBalance(branchId, firstItemId))).toBe('4.25');
    expect(String(await branchBalance(branchId, secondItemId))).toBe('1');
    expect(received.body.items[0].quantity_in_transit).toBe('6.25');
    expect(received.body.items[1].quantity_in_transit).toBe('1.25');
    expect(await movementCount(stockItemIds)).toBe(4);

    const conflictingReceipt = await request(app.getHttpServer())
      .post(`/dispatches/${created.body.id}/receive`)
      .set('Idempotency-Key', firstReceiptKey)
      .send({
        items: [
          { ...firstReceiptPayload.items[0], quantity_received: '4.5' },
          firstReceiptPayload.items[1],
        ],
      });
    const overReceipt = await request(app.getHttpServer())
      .post(`/dispatches/${created.body.id}/receive`)
      .set('Idempotency-Key', randomUUID())
      .send({
        items: [
          { dispatch_item_id: firstDispatchItem.id, quantity_received: '6.26' },
        ],
      });
    expect(conflictingReceipt.status).toBe(409);
    expect(overReceipt.status).toBe(400);

    const finalReceipt = await request(app.getHttpServer())
      .post(`/dispatches/${created.body.id}/receive`)
      .set('Idempotency-Key', randomUUID())
      .send({
        items: [
          { dispatch_item_id: firstDispatchItem.id, quantity_received: '6.25' },
          {
            dispatch_item_id: secondDispatchItem.id,
            quantity_received: '1.25',
          },
        ],
      });
    expect(finalReceipt.status).toBe(201);
    expect(finalReceipt.body.status).toBe('RECEIVED');
    expect(String(await branchBalance(branchId, firstItemId))).toBe('10.5');
    expect(String(await branchBalance(branchId, secondItemId))).toBe('2.25');
    expect(
      finalReceipt.body.items.every(
        (item: { quantity_in_transit: string }) =>
          item.quantity_in_transit === '0',
      ),
    ).toBe(true);

    const shortagePayload = dispatchPayload([
      { stock_item_id: firstItemId, quantity_dispatched: '5' },
    ]);
    const shortageDispatch = await request(app.getHttpServer())
      .post('/dispatches')
      .set('Idempotency-Key', randomUUID())
      .send(shortagePayload);
    expect(shortageDispatch.status).toBe(201);
    dispatchIds.push(shortageDispatch.body.id);
    const postedShortageDispatch = await request(app.getHttpServer())
      .post(`/dispatches/${shortageDispatch.body.id}/dispatch`)
      .set('Idempotency-Key', randomUUID())
      .send({});
    expect(postedShortageDispatch.status).toBe(201);
    const shortageItemId = postedShortageDispatch.body.items[0].id as string;
    const beforeShortageMovementCount = await movementCount(stockItemIds);
    const closedShortage = await request(app.getHttpServer())
      .post(`/dispatches/${shortageDispatch.body.id}/shortage-closures`)
      .set('Idempotency-Key', randomUUID())
      .send({
        reason: 'Branch count confirmed the package was missing',
        items: [{ dispatch_item_id: shortageItemId, quantity_closed: '1.5' }],
      });
    expect(closedShortage.status).toBe(201);
    expect(closedShortage.body.status).toBe('IN_TRANSIT');
    expect(closedShortage.body.items[0].quantity_in_transit).toBe('3.5');
    expect(closedShortage.body.shortage_closures[0].reason).toBe(
      'Branch count confirmed the package was missing',
    );
    expect(await movementCount(stockItemIds)).toBe(beforeShortageMovementCount);
    expect(String(await branchBalance(branchId, firstItemId))).toBe('10.5');

    const lastReceipt = await request(app.getHttpServer())
      .post(`/dispatches/${shortageDispatch.body.id}/receive`)
      .set('Idempotency-Key', randomUUID())
      .send({
        items: [{ dispatch_item_id: shortageItemId, quantity_received: '3.5' }],
      });
    expect(lastReceipt.status).toBe(201);
    expect(lastReceipt.body.status).toBe('CLOSED_WITH_SHORTAGE');
    expect(lastReceipt.body.items[0].quantity_in_transit).toBe('0');
    expect(String(await branchBalance(branchId, firstItemId))).toBe('14');

    const listed = await request(app.getHttpServer()).get(
      `/dispatches?branch_id=${branchId}&status=RECEIVED&page=1&page_size=10`,
    );
    const detail = await request(app.getHttpServer()).get(
      `/dispatches/${created.body.id}`,
    );
    expect(listed.status).toBe(200);
    expect(
      listed.body.items.some(
        (item: { id: string }) => item.id === created.body.id,
      ),
    ).toBe(true);
    expect(detail.status).toBe(200);
    expect(
      detail.body.events.map(
        (event: { event_type: string }) => event.event_type,
      ),
    ).toEqual([
      'CREATED',
      'DISPATCHED',
      'RECEIPT_RECORDED',
      'RECEIPT_RECORDED',
    ]);
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
      .send({});
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

  it('keeps partial receipts immutable and resolves discrepancies through receipt or shortage events', async () => {
    const stockItemId = stockItemIds[0];
    await setCommissaryBalance(stockItemId, '200');

    const payload = dispatchPayload([
      { stock_item_id: stockItemId, quantity_dispatched: '100' },
    ]);
    const created = await request(app.getHttpServer())
      .post('/dispatches')
      .set('Idempotency-Key', randomUUID())
      .send(payload);
    expect(created.status).toBe(201);
    dispatchIds.push(created.body.id);
    const dispatchItemId = created.body.items[0].id as string;
    const posted = await request(app.getHttpServer())
      .post(`/dispatches/${created.body.id}/dispatch`)
      .set('Idempotency-Key', randomUUID())
      .send({});
    expect(posted.status).toBe(201);

    const firstReceipt = await request(app.getHttpServer())
      .post(`/dispatches/${created.body.id}/receive`)
      .set('Idempotency-Key', randomUUID())
      .send({
        items: [{ dispatch_item_id: dispatchItemId, quantity_received: '80' }],
      });
    expect(firstReceipt.status).toBe(201);
    const reportKey = randomUUID();
    const reportPayload = {
      note: 'Only 80 of 100 units were present at receiving.',
    };
    const reported = await request(app.getHttpServer())
      .post(`/dispatches/${created.body.id}/discrepancies`)
      .set('Idempotency-Key', reportKey)
      .send(reportPayload);
    expect(reported.status).toBe(201);
    expect(reported.body).toMatchObject({
      status: 'PARTIALLY_RECEIVED',
      discrepancy: { status: 'OPEN' },
      items: [
        {
          quantity_dispatched: '100',
          quantity_received: '80',
          quantity_in_transit: '20',
        },
      ],
    });
    const reportRetry = await request(app.getHttpServer())
      .post(`/dispatches/${created.body.id}/discrepancies`)
      .set('Idempotency-Key', reportKey)
      .send(reportPayload);
    expect(reportRetry.status).toBe(201);
    expect(reportRetry.body.discrepancy_events).toHaveLength(1);
    const openQueue = await request(app.getHttpServer()).get(
      '/dispatches?discrepancy_status=OPEN',
    );
    expect(openQueue.status).toBe(200);
    expect(
      openQueue.body.items.map((item: { id: string }) => item.id),
    ).toContain(created.body.id);

    branchIds = [otherBranchId];
    const crossBranch = await request(app.getHttpServer())
      .post(`/dispatches/${created.body.id}/discrepancies/recount`)
      .set('Idempotency-Key', randomUUID())
      .send({ reason: 'Unauthorized cross-branch recount.' });
    expect(crossBranch.status).toBe(404);
    branchIds = [branchId];

    const recountKey = randomUUID();
    const recount = await request(app.getHttpServer())
      .post(`/dispatches/${created.body.id}/discrepancies/recount`)
      .set('Idempotency-Key', recountKey)
      .send({ reason: 'Please recount the receiving area.' });
    expect(recount.status).toBe(201);
    expect(recount.body.discrepancy.status).toBe('RECOUNT_REQUESTED');
    const recountRetry = await request(app.getHttpServer())
      .post(`/dispatches/${created.body.id}/discrepancies/recount`)
      .set('Idempotency-Key', recountKey)
      .send({ reason: 'Please recount the receiving area.' });
    expect(recountRetry.status).toBe(201);
    expect(recountRetry.body.discrepancy_events).toHaveLength(2);
    const finalReceipt = await request(app.getHttpServer())
      .post(`/dispatches/${created.body.id}/receive`)
      .set('Idempotency-Key', randomUUID())
      .send({
        items: [{ dispatch_item_id: dispatchItemId, quantity_received: '20' }],
      });
    expect(finalReceipt.status).toBe(201);
    expect(finalReceipt.body.discrepancy.status).toBe('RESOLVED');
    expect(finalReceipt.body.items[0].quantity_received).toBe('100');
    expect(finalReceipt.body.receipts).toHaveLength(2);

    const shortagePayload = dispatchPayload([
      { stock_item_id: stockItemId, quantity_dispatched: '100' },
    ]);
    const shortageDraft = await request(app.getHttpServer())
      .post('/dispatches')
      .set('Idempotency-Key', randomUUID())
      .send(shortagePayload);
    expect(shortageDraft.status).toBe(201);
    dispatchIds.push(shortageDraft.body.id);
    const shortageItemId = shortageDraft.body.items[0].id as string;
    await request(app.getHttpServer())
      .post(`/dispatches/${shortageDraft.body.id}/dispatch`)
      .set('Idempotency-Key', randomUUID())
      .send({});
    await request(app.getHttpServer())
      .post(`/dispatches/${shortageDraft.body.id}/receive`)
      .set('Idempotency-Key', randomUUID())
      .send({
        items: [{ dispatch_item_id: shortageItemId, quantity_received: '80' }],
      });
    const shortageReport = await request(app.getHttpServer())
      .post(`/dispatches/${shortageDraft.body.id}/discrepancies`)
      .set('Idempotency-Key', randomUUID())
      .send({ note: 'The remaining 20 units could not be located.' });
    expect(shortageReport.status).toBe(201);
    const shortageRecount = await request(app.getHttpServer())
      .post(`/dispatches/${shortageDraft.body.id}/discrepancies/recount`)
      .set('Idempotency-Key', randomUUID())
      .send({ reason: 'Branch confirmed the stock is missing.' });
    expect(shortageRecount.status).toBe(201);
    const closed = await request(app.getHttpServer())
      .post(`/dispatches/${shortageDraft.body.id}/shortage-closures`)
      .set('Idempotency-Key', randomUUID())
      .send({
        reason: 'Confirmed missing after branch recount.',
        items: [{ dispatch_item_id: shortageItemId, quantity_closed: '20' }],
      });
    expect(closed.status).toBe(201);
    expect(closed.body.status).toBe('CLOSED_WITH_SHORTAGE');
    expect(closed.body.discrepancy.status).toBe('RESOLVED');
    expect(
      closed.body.discrepancy_events.map(
        (event: { event_type: string }) => event.event_type,
      ),
    ).toEqual(['REPORTED', 'RECOUNT_REQUESTED', 'RESOLVED_SHORTAGE']);

    await db
      .updateTable('commissary_inventory')
      .set({ quantity_on_hand: '100' })
      .where('stock_item_id', '=', stockItemId)
      .execute();
    const mixedPayload = dispatchPayload([
      { stock_item_id: stockItemId, quantity_dispatched: '100' },
    ]);
    const mixedDraft = await request(app.getHttpServer())
      .post('/dispatches')
      .set('Idempotency-Key', randomUUID())
      .send(mixedPayload);
    expect(mixedDraft.status).toBe(201);
    dispatchIds.push(mixedDraft.body.id);
    const mixedItemId = mixedDraft.body.items[0].id as string;
    const mixedDispatch = await request(app.getHttpServer())
      .post(`/dispatches/${mixedDraft.body.id}/dispatch`)
      .set('Idempotency-Key', randomUUID())
      .send({});
    expect(mixedDispatch.status).toBe(201);
    const partialMixedReceipt = await request(app.getHttpServer())
      .post(`/dispatches/${mixedDraft.body.id}/receive`)
      .set('Idempotency-Key', randomUUID())
      .send({
        items: [{ dispatch_item_id: mixedItemId, quantity_received: '60' }],
      });
    expect(partialMixedReceipt.status).toBe(201);
    await request(app.getHttpServer())
      .post(`/dispatches/${mixedDraft.body.id}/discrepancies`)
      .set('Idempotency-Key', randomUUID())
      .send({ note: 'A portion of the dispatched quantity is missing.' });
    const laterReceipt = await request(app.getHttpServer())
      .post(`/dispatches/${mixedDraft.body.id}/receive`)
      .set('Idempotency-Key', randomUUID())
      .send({
        items: [{ dispatch_item_id: mixedItemId, quantity_received: '20' }],
      });
    expect(laterReceipt.status).toBe(201);
    const mixedShortage = await request(app.getHttpServer())
      .post(`/dispatches/${mixedDraft.body.id}/shortage-closures`)
      .set('Idempotency-Key', randomUUID())
      .send({
        reason: 'Remaining quantity confirmed missing after review.',
        items: [{ dispatch_item_id: mixedItemId, quantity_closed: '20' }],
      });
    expect(mixedShortage.status).toBe(201);
    expect(mixedShortage.body.discrepancy.status).toBe('RESOLVED');
    expect(mixedShortage.body.items[0]).toMatchObject({
      quantity_received: '80',
      quantity_shortage_closed: '20',
      quantity_in_transit: '0',
    });
  });

  it('sends multiple exact decimal lines atomically and replays concurrent requests after receipt', async () => {
    await setCommissaryBalance(stockItemIds[0], '10');
    await setCommissaryBalance(stockItemIds[1], '5');
    const key = randomUUID();
    const payload = dispatchPayload([
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
    const item = dispatched.items.find(
      (line: { stock_item_id: string }) =>
        line.stock_item_id === stockItemIds[0],
    );
    expect(
      (
        await request(app.getHttpServer())
          .post(`/dispatches/${dispatched.id}/receive`)
          .set('Idempotency-Key', randomUUID())
          .send({
            items: [{ dispatch_item_id: item.id, quantity_received: '1' }],
          })
      ).status,
    ).toBe(201);
    expect((await send()).body.status).toBe('PARTIALLY_RECEIVED');
    const rest = dispatched.items.map(
      (line: { id: string; stock_item_id: string }) => ({
        dispatch_item_id: line.id,
        quantity_received:
          line.stock_item_id === stockItemIds[0] ? '1.5' : '1.125',
      }),
    );
    expect(
      (
        await request(app.getHttpServer())
          .post(`/dispatches/${dispatched.id}/receive`)
          .set('Idempotency-Key', randomUUID())
          .send({ items: rest })
      ).status,
    ).toBe(201);
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
    currentUserId = deniedUserId;
    expect((await send()).status).toBe(409);
    currentUserId = actorUserId;
    expect(
      (
        await request(app.getHttpServer())
          .post('/dispatches')
          .set('Idempotency-Key', key)
          .send(payload)
      ).status,
    ).toBe(409);
    expect(
      (
        await request(app.getHttpServer())
          .post(`/dispatches/${dispatched.id}/dispatch`)
          .set('Idempotency-Key', key)
          .send({})
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
        dispatchPayload(
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
    const payload = dispatchPayload([
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
                dispatchPayload([
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
            dispatchPayload([
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
