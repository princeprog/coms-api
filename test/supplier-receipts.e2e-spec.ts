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

describe('supplier receipt routes (e2e)', () => {
  const suffix = randomUUID();
  const supplierIds: string[] = [];
  const stockItemIds: string[] = [];
  const receiptIds: string[] = [];
  let supplierId: string;
  let secondarySupplierId: string;
  let actorUserId: string;
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
              code: 'RECEIPT_TEST',
              name: 'Receipt Test',
              isSystem: false,
              isActive: true,
            },
            permissions: [
              'supplier_receipts.read',
              'supplier_receipts.create',
              'supplier_receipts.post',
              'inventory.read',
            ],
            branchIds: [],
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

    const supplier = await createSupplier(`Receipt Supplier ${suffix}`);
    supplierId = supplier;
    supplierIds.push(supplier);
    const secondarySupplier = await createSupplier(
      `Inactive Receipt Supplier ${suffix}`,
    );
    secondarySupplierId = secondarySupplier;
    supplierIds.push(secondarySupplier);

    stockItemIds.push(
      await createStockItem(`Receipt flour ${suffix}`),
      await createStockItem(`Receipt oil ${suffix}`),
      await createStockItem(`Receipt sugar ${suffix}`),
      await createStockItem(`Inactive receipt item ${suffix}`),
    );
  });

  afterAll(async () => {
    if (stockItemIds.length) {
      await db
        .deleteFrom('inventory_movements')
        .where('stock_item_id', 'in', stockItemIds)
        .execute();
      await db
        .deleteFrom('commissary_inventory')
        .where('stock_item_id', 'in', stockItemIds)
        .execute();
    }
    if (receiptIds.length) {
      await db
        .deleteFrom('supplier_receipt_items')
        .where('supplier_receipt_id', 'in', receiptIds)
        .execute();
      await db
        .deleteFrom('supplier_receipts')
        .where('id', 'in', receiptIds)
        .execute();
    }
    if (stockItemIds.length) {
      await db
        .deleteFrom('stock_items')
        .where('id', 'in', stockItemIds)
        .execute();
    }
    if (supplierIds.length) {
      await db.deleteFrom('suppliers').where('id', 'in', supplierIds).execute();
    }
    await Promise.all([app.close(), guardedApp.close()]);
  });

  it.each([
    { method: 'GET', path: '/supplier-receipts' },
    {
      method: 'GET',
      path: '/supplier-receipts/00000000-0000-4000-8000-000000000001',
    },
    { method: 'POST', path: '/supplier-receipts' },
    {
      method: 'POST',
      path: '/supplier-receipts/00000000-0000-4000-8000-000000000001/post',
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

  it('validates date, lines, decimal strings, and create idempotency keys', async () => {
    const path = '/supplier-receipts';
    const validLine = {
      stock_item_id: stockItemIds[0],
      quantity_received: '1',
      unit_cost: '2',
    };
    const validReceipt = {
      supplier_id: supplierId,
      received_at: '2026-09-24',
      items: [validLine],
    };
    const missingKey = await request(app.getHttpServer())
      .post(path)
      .send(validReceipt);
    const invalidKey = await request(app.getHttpServer())
      .post(path)
      .set('Idempotency-Key', 'invalid')
      .send(validReceipt);
    const invalidDate = await request(app.getHttpServer())
      .post(path)
      .set('Idempotency-Key', randomUUID())
      .send({ ...validReceipt, received_at: '2026-02-30' });
    const noItems = await request(app.getHttpServer())
      .post(path)
      .set('Idempotency-Key', randomUUID())
      .send({ ...validReceipt, items: [] });
    const invalidQuantity = await request(app.getHttpServer())
      .post(path)
      .set('Idempotency-Key', randomUUID())
      .send({
        ...validReceipt,
        items: [{ ...validLine, quantity_received: '0' }],
      });
    const invalidCost = await request(app.getHttpServer())
      .post(path)
      .set('Idempotency-Key', randomUUID())
      .send({ ...validReceipt, items: [{ ...validLine, unit_cost: '-1' }] });

    expect(missingKey.status).toBe(400);
    expect(invalidKey.status).toBe(400);
    expect(invalidDate.status).toBe(400);
    expect(noItems.status).toBe(400);
    expect(invalidQuantity.status).toBe(400);
    expect(invalidCost.status).toBe(400);
  });

  it('creates an idempotent draft, lists details, and posts each receipt line exactly once', async () => {
    const idempotencyKey = randomUUID();
    const path = '/supplier-receipts';
    const receipt = {
      supplier_id: supplierId,
      received_at: '2026-09-24',
      items: [
        {
          stock_item_id: stockItemIds[0],
          quantity_received: '2.5000',
          unit_cost: '13.250',
        },
        {
          stock_item_id: stockItemIds[1],
          quantity_received: '1',
          unit_cost: '0.5',
        },
      ],
    };
    const equivalentRetry = {
      ...receipt,
      items: [
        { ...receipt.items[0], quantity_received: '2.5', unit_cost: '13.25' },
        { ...receipt.items[1], unit_cost: '0.50' },
      ],
    };

    const created = await request(app.getHttpServer())
      .post(path)
      .set('Idempotency-Key', idempotencyKey)
      .send(receipt);
    expect(created.status).toBe(201);
    receiptIds.push(created.body.id);
    expect(created.body).toMatchObject({
      supplier_id: supplierId,
      supplier_name: `Receipt Supplier ${suffix}`,
      received_at: '2026-09-24',
      status: 'DRAFT',
      created_by_user_id: actorUserId,
      total_cost: '33.625',
    });
    expect(created.body.items).toHaveLength(2);

    const retried = await request(app.getHttpServer())
      .post(path)
      .set('Idempotency-Key', idempotencyKey)
      .send(equivalentRetry);
    const conflictingRetry = await request(app.getHttpServer())
      .post(path)
      .set('Idempotency-Key', idempotencyKey)
      .send({
        ...receipt,
        items: [{ ...receipt.items[0], quantity_received: '3' }],
      });
    const listed = await request(app.getHttpServer()).get(
      `/supplier-receipts?status=DRAFT&supplier_id=${supplierId}&search=${encodeURIComponent(`Receipt Supplier ${suffix}`)}`,
    );
    const detail = await request(app.getHttpServer()).get(
      `/supplier-receipts/${created.body.id}`,
    );

    expect(retried.status).toBe(201);
    expect(retried.body.id).toBe(created.body.id);
    expect(conflictingRetry.status).toBe(409);
    expect(listed.status).toBe(200);
    expect(listed.body).toMatchObject({ total: 1, page: 1, page_size: 25 });
    expect(listed.body.items[0]).toMatchObject({
      id: created.body.id,
      item_count: 2,
      total_cost: '33.625',
    });
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({
      id: created.body.id,
      status: 'DRAFT',
      total_cost: '33.625',
    });

    const posted = await request(app.getHttpServer()).post(
      `${path}/${created.body.id}/post`,
    );
    const repeatedPost = await request(app.getHttpServer()).post(
      `${path}/${created.body.id}/post`,
    );
    const itemIds = created.body.items.map((item: { id: string }) => item.id);
    const movements = await db
      .selectFrom('inventory_movements')
      .select([
        'id',
        'stock_item_id',
        'quantity_delta',
        'supplier_receipt_item_id',
      ])
      .where('supplier_receipt_item_id', 'in', itemIds)
      .orderBy('stock_item_id')
      .execute();
    const balances = await db
      .selectFrom('commissary_inventory')
      .select(['stock_item_id', 'quantity_on_hand'])
      .where('stock_item_id', 'in', [stockItemIds[0], stockItemIds[1]])
      .orderBy('stock_item_id')
      .execute();

    expect(posted.status).toBe(201);
    expect(posted.body).toMatchObject({
      id: created.body.id,
      status: 'POSTED',
      posted_by_user_id: actorUserId,
    });
    expect(repeatedPost.status).toBe(201);
    expect(repeatedPost.body.id).toBe(posted.body.id);
    expect(movements).toHaveLength(2);
    expect(
      movements
        .map((movement) => movement.supplier_receipt_item_id)
        .sort((left, right) => left!.localeCompare(right!)),
    ).toEqual([...itemIds].sort((left, right) => left.localeCompare(right)));
    const balanceByStockItemId = new Map(
      balances.map((balance) => [
        balance.stock_item_id,
        balance.quantity_on_hand,
      ]),
    );
    expect(balanceByStockItemId.get(stockItemIds[0])).toBe('2.5');
    expect(balanceByStockItemId.get(stockItemIds[1])).toBe('1');
  });

  it('coalesces simultaneous create and post retries into one posted receipt', async () => {
    const idempotencyKey = randomUUID();
    const path = '/supplier-receipts';
    const receipt = {
      supplier_id: supplierId,
      received_at: '2026-09-24',
      items: [
        {
          stock_item_id: stockItemIds[2],
          quantity_received: '3',
          unit_cost: '2',
        },
      ],
    };
    const create = () =>
      request(app.getHttpServer())
        .post(path)
        .set('Idempotency-Key', idempotencyKey)
        .send(receipt);
    const [first, duplicate] = await Promise.all([create(), create()]);
    expect(first.status).toBe(201);
    expect(duplicate.status).toBe(201);
    expect(duplicate.body.id).toBe(first.body.id);
    receiptIds.push(first.body.id);

    const [posted, retry] = await Promise.all([
      request(app.getHttpServer()).post(`${path}/${first.body.id}/post`),
      request(app.getHttpServer()).post(`${path}/${first.body.id}/post`),
    ]);
    const movementCount = await db
      .selectFrom('inventory_movements')
      .select((eb) => eb.fn.countAll<number>().as('total'))
      .where('supplier_receipt_item_id', '=', first.body.items[0].id)
      .executeTakeFirstOrThrow();
    const balance = await db
      .selectFrom('commissary_inventory')
      .select('quantity_on_hand')
      .where('stock_item_id', '=', stockItemIds[2])
      .executeTakeFirstOrThrow();

    expect(posted.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(retry.body.id).toBe(first.body.id);
    expect(Number(movementCount.total)).toBe(1);
    expect(balance.quantity_on_hand).toBe('3');
  });

  it('rejects inactive suppliers and stock items', async () => {
    const validReceipt = {
      supplier_id: secondarySupplierId,
      received_at: '2026-09-24',
      items: [
        {
          stock_item_id: stockItemIds[3],
          quantity_received: '1',
          unit_cost: '1',
        },
      ],
    };
    await db
      .updateTable('suppliers')
      .set({ is_active: false })
      .where('id', '=', secondarySupplierId)
      .execute();
    const inactiveSupplier = await request(app.getHttpServer())
      .post('/supplier-receipts')
      .set('Idempotency-Key', randomUUID())
      .send(validReceipt);
    await db
      .updateTable('suppliers')
      .set({ is_active: true })
      .where('id', '=', secondarySupplierId)
      .execute();
    await db
      .updateTable('stock_items')
      .set({ is_active: false })
      .where('id', '=', stockItemIds[3])
      .execute();
    const inactiveStockItem = await request(app.getHttpServer())
      .post('/supplier-receipts')
      .set('Idempotency-Key', randomUUID())
      .send(validReceipt);

    expect(inactiveSupplier.status).toBe(404);
    expect(inactiveStockItem.status).toBe(404);
  });

  async function createSupplier(name: string): Promise<string> {
    const supplier = await db
      .insertInto('suppliers')
      .values({ supplier_name: name })
      .returning('id')
      .executeTakeFirstOrThrow();
    return supplier.id;
  }

  async function createStockItem(name: string): Promise<string> {
    const stockItem = await db
      .insertInto('stock_items')
      .values({ stock_item_name: name, category: 'Test', unit: 'kg' })
      .returning('id')
      .executeTakeFirstOrThrow();
    return stockItem.id;
  }
});
