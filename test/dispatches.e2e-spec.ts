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
  const requestIds: string[] = [];
  const stockItemIds: string[] = [];
  const branchIdsToDelete: string[] = [];
  let branchId: string;
  let otherBranchId: string;
  let actorUserId: string;
  let currentUserId: string;
  let branchIds: string[] = [];
  let app: INestApplication<App>;
  let guardedApp: INestApplication<App>;
  let deniedPermissionApp: INestApplication<App>;
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
            permissions: [
              'dispatches.read',
              'dispatches.create',
              'dispatches.dispatch',
              'dispatches.receive',
              'dispatches.shortage_close',
            ],
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
            id: actorUserId,
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
    if (requestIds.length) {
      await db
        .deleteFrom('stock_request_events')
        .where('stock_request_id', 'in', requestIds)
        .execute();
      await db
        .deleteFrom('stock_request_items')
        .where('stock_request_id', 'in', requestIds)
        .execute();
      await db
        .deleteFrom('stock_requests')
        .where('id', 'in', requestIds)
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
    const create = await request(app.getHttpServer())
      .post('/dispatches')
      .send({ stock_request_id: randomUUID() });
    const invalidCreateKey = await request(app.getHttpServer())
      .post('/dispatches')
      .set('Idempotency-Key', 'invalid')
      .send({ stock_request_id: randomUUID() });
    expect(create.status).toBe(400);
    expect(invalidCreateKey.status).toBe(400);

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
    const requestId = await createApprovedRequest([
      { stock_item_id: stockItemIds[0], quantity_requested: '2' },
    ]);
    const idempotencyKey = randomUUID();
    const responses = await Promise.all(
      Array.from({ length: 12 }, () =>
        request(app.getHttpServer())
          .post('/dispatches')
          .set('Idempotency-Key', idempotencyKey)
          .send({ stock_request_id: requestId }),
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
    const requestId = await createApprovedRequest([
      { stock_item_id: firstItemId, quantity_requested: '10.5' },
      { stock_item_id: secondItemId, quantity_requested: '2.25' },
    ]);
    const createKey = randomUUID();
    const createPayload = { stock_request_id: requestId };
    const created = await request(app.getHttpServer())
      .post('/dispatches')
      .set('Idempotency-Key', createKey)
      .send(createPayload);
    expect(created.status).toBe(201);
    dispatchIds.push(created.body.id);
    expect(created.body).toMatchObject({
      stock_request_id: requestId,
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

    const shortageRequestId = await createApprovedRequest([
      { stock_item_id: firstItemId, quantity_requested: '5' },
    ]);
    const shortageDispatch = await request(app.getHttpServer())
      .post('/dispatches')
      .set('Idempotency-Key', randomUUID())
      .send({ stock_request_id: shortageRequestId });
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
    const requestId = await createApprovedRequest([
      { stock_item_id: stockItemIds[1], quantity_requested: '500' },
    ]);
    const created = await request(app.getHttpServer())
      .post('/dispatches')
      .set('Idempotency-Key', randomUUID())
      .send({ stock_request_id: requestId });
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

    const otherScopeRequestId = await createApprovedRequest([
      { stock_item_id: stockItemIds[0], quantity_requested: '1' },
    ]);
    branchIds = [otherBranchId];
    const outOfScopeCreate = await request(app.getHttpServer())
      .post('/dispatches')
      .set('Idempotency-Key', randomUUID())
      .send({ stock_request_id: otherScopeRequestId });
    const outOfScopeFilter = await request(app.getHttpServer()).get(
      `/dispatches?branch_id=${branchId}`,
    );
    expect(outOfScopeCreate.status).toBe(403);
    expect(outOfScopeFilter.status).toBe(403);
    branchIds = [branchId];
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

  async function createApprovedRequest(
    items: Array<{ stock_item_id: string; quantity_requested: string }>,
  ): Promise<string> {
    const created = await db
      .insertInto('stock_requests')
      .values({
        branch_id: branchId,
        requested_by_user_id: actorUserId,
        status: 'APPROVED',
        idempotency_key: randomUUID(),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    requestIds.push(created.id);
    const lines = await db
      .insertInto('stock_request_items')
      .values(
        items.map((item) => ({
          stock_request_id: created.id,
          stock_item_id: item.stock_item_id,
          quantity_requested: item.quantity_requested,
        })),
      )
      .returning('id')
      .execute();
    await db
      .insertInto('stock_request_events')
      .values([
        {
          stock_request_id: created.id,
          event_type: 'SUBMITTED',
          actor_user_id: actorUserId,
        },
        {
          stock_request_id: created.id,
          event_type: 'APPROVED',
          actor_user_id: actorUserId,
        },
      ])
      .execute();
    expect(lines).toHaveLength(items.length);
    return created.id;
  }

  async function setCommissaryBalance(stockItemId: string, quantity: string) {
    await db
      .insertInto('commissary_inventory')
      .values({ stock_item_id: stockItemId, quantity_on_hand: quantity })
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
