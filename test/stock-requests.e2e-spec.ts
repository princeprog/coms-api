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

describe('stock request routes (e2e)', () => {
  const suffix = randomUUID();
  const requestIds: string[] = [];
  const stockItemIds: string[] = [];
  const userIds: string[] = [];
  let branchId: string;
  let otherBranchId: string;
  let actorUserId: string;
  let otherUserId: string;
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
              id: 'stock-request-test-role',
              code: 'STOCK_REQUEST_TEST',
              name: 'Stock Request Test',
              isSystem: false,
              isActive: true,
            },
            permissions: [
              'stock_requests.read',
              'stock_requests.create',
              'stock_requests.approve',
              'stock_requests.reject',
              'stock_requests.cancel',
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

    const actor = await db
      .selectFrom('auth.users')
      .select('id')
      .limit(1)
      .executeTakeFirstOrThrow();
    actorUserId = actor.id;
    currentUserId = actorUserId;

    const noAccessRole = await db
      .selectFrom('auth.roles')
      .select('id')
      .where('code', '=', 'NO_ACCESS')
      .executeTakeFirstOrThrow();
    const otherUser = await db
      .insertInto('auth.users')
      .values({
        email: `stock-request-test-${suffix}@example.com`,
        full_name: 'Stock Request E2E Test User',
        contact_number: `SR-${suffix.slice(0, 20)}`,
        hashed_password: 'test-only-hash',
        role_id: noAccessRole.id,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    otherUserId = otherUser.id;
    userIds.push(otherUserId);

    const deniedModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideGuard(AuthGatewayGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(AuthGuard)
      .useValue({
        canActivate: (execution: ExecutionContext) => {
          execution.switchToHttp().getRequest<TestRequest>().user = {
            id: otherUserId,
          };
          return true;
        },
      })
      .compile();
    deniedPermissionApp = deniedModule.createNestApplication();
    await deniedPermissionApp.init();

    const branch = await db
      .insertInto('branches')
      .values({
        code: `SR-${suffix.slice(0, 8)}`,
        branch_name: `Stock Request ${suffix}`,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    branchId = branch.id;
    const otherBranch = await db
      .insertInto('branches')
      .values({
        code: `SR2-${suffix.slice(0, 8)}`,
        branch_name: `Other Stock Request ${suffix}`,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    otherBranchId = otherBranch.id;
    branchIds = [branchId];

    stockItemIds.push(
      await createStockItem(`Stock Request Flour ${suffix}`),
      await createStockItem(`Stock Request Oil ${suffix}`),
    );
  });

  afterAll(async () => {
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
    if (stockItemIds.length)
      await db
        .deleteFrom('stock_items')
        .where('id', 'in', stockItemIds)
        .execute();
    if (branchId)
      await db.deleteFrom('branches').where('id', '=', branchId).execute();
    if (otherBranchId)
      await db.deleteFrom('branches').where('id', '=', otherBranchId).execute();
    if (userIds.length)
      await db.deleteFrom('auth.users').where('id', 'in', userIds).execute();
    await Promise.all([
      app.close(),
      guardedApp.close(),
      deniedPermissionApp.close(),
    ]);
  });

  it.each([
    { method: 'GET', path: '/stock-requests' },
    {
      method: 'GET',
      path: '/stock-requests/00000000-0000-4000-8000-000000000001',
    },
    { method: 'POST', path: '/stock-requests' },
    {
      method: 'POST',
      path: '/stock-requests/00000000-0000-4000-8000-000000000001/approve',
    },
    {
      method: 'POST',
      path: '/stock-requests/00000000-0000-4000-8000-000000000001/reject',
    },
    {
      method: 'POST',
      path: '/stock-requests/00000000-0000-4000-8000-000000000001/cancel',
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

  it('denies a valid session whose current role has no stock request grant', async () => {
    const response = await request(deniedPermissionApp.getHttpServer()).get(
      '/stock-requests',
    );
    expect(response.status).toBe(403);
    expect(response.body.message).toBe('Permission required');
  });

  it('validates lines and idempotency, then lists exact decimal request details', async () => {
    const path = '/stock-requests';
    const validRequest = {
      branch_id: branchId,
      items: [
        { stock_item_id: stockItemIds[0], quantity_requested: '2.5000' },
        { stock_item_id: stockItemIds[1], quantity_requested: '1.25' },
      ],
    };
    const missingKey = await request(app.getHttpServer())
      .post(path)
      .send(validRequest);
    const invalidKey = await request(app.getHttpServer())
      .post(path)
      .set('Idempotency-Key', 'not-a-uuid')
      .send(validRequest);
    const emptyItems = await request(app.getHttpServer())
      .post(path)
      .set('Idempotency-Key', randomUUID())
      .send({ ...validRequest, items: [] });
    const zeroQuantity = await request(app.getHttpServer())
      .post(path)
      .set('Idempotency-Key', randomUUID())
      .send({
        ...validRequest,
        items: [{ ...validRequest.items[0], quantity_requested: '0' }],
      });
    const duplicateItems = await request(app.getHttpServer())
      .post(path)
      .set('Idempotency-Key', randomUUID())
      .send({
        ...validRequest,
        items: [validRequest.items[0], validRequest.items[0]],
      });
    expect(missingKey.status).toBe(400);
    expect(invalidKey.status).toBe(400);
    expect(emptyItems.status).toBe(400);
    expect(zeroQuantity.status).toBe(400);
    expect(duplicateItems.status).toBe(400);

    const idempotencyKey = randomUUID();
    const created = await request(app.getHttpServer())
      .post(path)
      .set('Idempotency-Key', idempotencyKey)
      .send(validRequest);
    expect(created.status).toBe(201);
    requestIds.push(created.body.id);
    expect(created.body).toMatchObject({
      branch_id: branchId,
      requested_by_user_id: actorUserId,
      status: 'PENDING',
    });
    expect(
      created.body.items.map(
        (item: { quantity_requested: string }) => item.quantity_requested,
      ),
    ).toEqual(['2.5', '1.25']);
    expect(
      created.body.events.map(
        (event: { event_type: string }) => event.event_type,
      ),
    ).toEqual(['SUBMITTED']);

    const retry = await request(app.getHttpServer())
      .post(path)
      .set('Idempotency-Key', idempotencyKey)
      .send({
        ...validRequest,
        items: [
          { ...validRequest.items[0], quantity_requested: '2.5' },
          validRequest.items[1],
        ],
      });
    const conflict = await request(app.getHttpServer())
      .post(path)
      .set('Idempotency-Key', idempotencyKey)
      .send({
        ...validRequest,
        items: [
          { ...validRequest.items[0], quantity_requested: '3' },
          validRequest.items[1],
        ],
      });
    const listed = await request(app.getHttpServer()).get(
      `/stock-requests?branch_id=${branchId}&status=PENDING&page=1&page_size=10`,
    );
    const detail = await request(app.getHttpServer()).get(
      `${path}/${created.body.id}`,
    );
    expect(retry.status).toBe(201);
    expect(retry.body.id).toBe(created.body.id);
    expect(conflict.status).toBe(409);
    expect(listed.status).toBe(200);
    expect(listed.body).toMatchObject({ page: 1, page_size: 10 });
    expect(
      listed.body.items.some(
        (item: { id: string }) => item.id === created.body.id,
      ),
    ).toBe(true);
    expect(detail.status).toBe(200);
    expect(detail.body.id).toBe(created.body.id);
  });

  it('creates one request when matching idempotency retries arrive concurrently', async () => {
    const idempotencyKey = randomUUID();
    const payload = {
      branch_id: branchId,
      items: [{ stock_item_id: stockItemIds[0], quantity_requested: '4.2500' }],
    };
    const post = () =>
      request(app.getHttpServer())
        .post('/stock-requests')
        .set('Idempotency-Key', idempotencyKey)
        .send(payload);

    const [first, retry] = await Promise.all([post(), post()]);
    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(retry.body.id).toBe(first.body.id);
    requestIds.push(first.body.id);

    const requests = await db
      .selectFrom('stock_requests')
      .select('id')
      .where('idempotency_key', '=', idempotencyKey)
      .execute();
    const events = await db
      .selectFrom('stock_request_events')
      .select('id')
      .where('stock_request_id', '=', first.body.id)
      .execute();
    expect(requests).toHaveLength(1);
    expect(events).toHaveLength(1);
  });

  it('supports pending transitions with actor history and creator-only cancellation', async () => {
    const createRequest = async () => {
      const response = await request(app.getHttpServer())
        .post('/stock-requests')
        .set('Idempotency-Key', randomUUID())
        .send({
          branch_id: branchId,
          items: [{ stock_item_id: stockItemIds[0], quantity_requested: '1' }],
        });
      expect(response.status).toBe(201);
      requestIds.push(response.body.id);
      return response.body.id as string;
    };

    const approveId = await createRequest();
    currentUserId = otherUserId;
    const approved = await request(app.getHttpServer()).post(
      `/stock-requests/${approveId}/approve`,
    );
    const duplicateApproval = await request(app.getHttpServer()).post(
      `/stock-requests/${approveId}/approve`,
    );
    expect(approved.status).toBe(201);
    expect(approved.body.status).toBe('APPROVED');
    expect(approved.body.events.at(-1)).toMatchObject({
      event_type: 'APPROVED',
      actor_user_id: otherUserId,
    });
    expect(duplicateApproval.status).toBe(409);

    const concurrentId = await createRequest();
    const concurrentApprovals = await Promise.all([
      request(app.getHttpServer()).post(
        `/stock-requests/${concurrentId}/approve`,
      ),
      request(app.getHttpServer()).post(
        `/stock-requests/${concurrentId}/approve`,
      ),
    ]);
    expect(
      concurrentApprovals
        .map((response) => response.status)
        .sort((left, right) => left - right),
    ).toEqual([201, 409]);

    const rejectId = await createRequest();
    const rejected = await request(app.getHttpServer()).post(
      `/stock-requests/${rejectId}/reject`,
    );
    expect(rejected.status).toBe(201);
    expect(rejected.body.status).toBe('REJECTED');
    expect(rejected.body.events.at(-1).event_type).toBe('REJECTED');

    currentUserId = actorUserId;
    const cancelId = await createRequest();
    currentUserId = otherUserId;
    const notOwnerCancellation = await request(app.getHttpServer()).post(
      `/stock-requests/${cancelId}/cancel`,
    );
    currentUserId = actorUserId;
    const cancelled = await request(app.getHttpServer()).post(
      `/stock-requests/${cancelId}/cancel`,
    );
    expect(notOwnerCancellation.status).toBe(403);
    expect(cancelled.status).toBe(201);
    expect(cancelled.body.status).toBe('CANCELLED');
    expect(cancelled.body.events.at(-1).event_type).toBe('CANCELLED');

    const movements = await db
      .selectFrom('inventory_movements')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('stock_item_id', '=', stockItemIds[0])
      .executeTakeFirstOrThrow();
    expect(Number(movements.count)).toBe(0);
  });

  it('filters all request access by the actor branch assignments', async () => {
    currentUserId = actorUserId;
    branchIds = [branchId];
    const created = await request(app.getHttpServer())
      .post('/stock-requests')
      .set('Idempotency-Key', randomUUID())
      .send({
        branch_id: branchId,
        items: [{ stock_item_id: stockItemIds[0], quantity_requested: '1' }],
      });
    expect(created.status).toBe(201);
    requestIds.push(created.body.id);

    branchIds = [otherBranchId];
    const hiddenDetail = await request(app.getHttpServer()).get(
      `/stock-requests/${created.body.id}`,
    );
    const hiddenList = await request(app.getHttpServer()).get(
      '/stock-requests',
    );
    const otherBranchFilter = await request(app.getHttpServer()).get(
      `/stock-requests?branch_id=${branchId}`,
    );
    const outOfScopeCreate = await request(app.getHttpServer())
      .post('/stock-requests')
      .set('Idempotency-Key', randomUUID())
      .send({
        branch_id: branchId,
        items: [{ stock_item_id: stockItemIds[0], quantity_requested: '1' }],
      });
    expect(hiddenDetail.status).toBe(404);
    expect(hiddenList.body.total).toBe(0);
    expect(otherBranchFilter.status).toBe(403);
    expect(outOfScopeCreate.status).toBe(403);
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
