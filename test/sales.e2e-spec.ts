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
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthGatewayGuard } from '../src/common/guards/auth-gateway.guard';
import { AuthGuard } from '../src/common/guards/auth.guard';
import { AppModule } from '../src/app.module';
import { DATABASE } from '../src/database/database.module';
import type { DB } from '../src/database/db';

type TestRequest = { user?: { id: string } };

describe('sales routes (e2e)', () => {
  const suffix = randomUUID();
  const roleIds: string[] = [];
  const userIds: string[] = [];
  const branchIds: string[] = [];
  const productIds: string[] = [];
  const stockItemIds: string[] = [];
  let actorUserId: string;
  let deniedUserId: string;
  let branchId: string;
  let otherBranchId: string;
  let productId: string;
  let multiIngredientProductId: string;
  let noRecipeProductId: string;
  let stockItemId: string;
  let secondStockItemId: string;
  let app: INestApplication<App>;
  let deniedApp: INestApplication<App>;
  let db: Kysely<DB>;

  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] })
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

    const role = await db
      .insertInto('auth.roles')
      .values({
        code: `SALES_TEST_${suffix.replaceAll('-', '').slice(0, 12).toUpperCase()}`,
        role_name: `Sales Test ${suffix}`,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    roleIds.push(role.id);
    const deniedRole = await db
      .insertInto('auth.roles')
      .values({
        code: `SALES_DENIED_${suffix.replaceAll('-', '').slice(0, 10).toUpperCase()}`,
        role_name: `Sales Denied ${suffix}`,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    roleIds.push(deniedRole.id);

    actorUserId = await createUser(role.id, 'cashier');
    deniedUserId = await createUser(deniedRole.id, 'denied');
    userIds.push(actorUserId, deniedUserId);

    const permissions = await db
      .selectFrom('auth.permissions')
      .select('id')
      .where('module_key', '=', 'sales')
      .where('action_key', 'in', ['read', 'create', 'void'])
      .execute();
    const inventoryAdjustPermission = await db
      .selectFrom('auth.permissions')
      .select('id')
      .where('module_key', '=', 'inventory')
      .where('action_key', '=', 'adjust')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('auth.role_permissions')
      .values([
        ...permissions.map(({ id }) => ({
          role_id: role.id,
          permission_id: id,
        })),
        { role_id: role.id, permission_id: inventoryAdjustPermission.id },
      ])
      .execute();

    branchId = await createBranch(`Sales Branch ${suffix}`);
    otherBranchId = await createBranch(`Other Sales Branch ${suffix}`);
    await db
      .insertInto('auth.branch_users')
      .values({ user_id: actorUserId, branch_id: branchId })
      .execute();

    const stockItem = await db
      .insertInto('stock_items')
      .values({
        stock_item_name: `Sales test flour ${suffix}`,
        category: 'Sales test',
        unit: 'kg',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    stockItemId = stockItem.id;
    stockItemIds.push(stockItemId);
    const secondStockItem = await db
      .insertInto('stock_items')
      .values({
        stock_item_name: `Sales test oil ${suffix}`,
        category: 'Sales test',
        unit: 'L',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    secondStockItemId = secondStockItem.id;
    stockItemIds.push(secondStockItemId);

    const product = await db
      .insertInto('products')
      .values({ product_name: `Sales product ${suffix}` })
      .returning('id')
      .executeTakeFirstOrThrow();
    productId = product.id;
    productIds.push(productId);
    const multiIngredientProduct = await db
      .insertInto('products')
      .values({ product_name: `Multi ingredient sales product ${suffix}` })
      .returning('id')
      .executeTakeFirstOrThrow();
    multiIngredientProductId = multiIngredientProduct.id;
    productIds.push(multiIngredientProductId);
    const noRecipeProduct = await db
      .insertInto('products')
      .values({ product_name: `No recipe sales product ${suffix}` })
      .returning('id')
      .executeTakeFirstOrThrow();
    noRecipeProductId = noRecipeProduct.id;
    productIds.push(noRecipeProductId);

    await db
      .insertInto('branch_products')
      .values([
        { branch_id: branchId, product_id: productId, price: '9.2500' },
        {
          branch_id: branchId,
          product_id: multiIngredientProductId,
          price: '3.00',
        },
        { branch_id: branchId, product_id: noRecipeProductId, price: '5.00' },
      ])
      .execute();
    await db
      .insertInto('product_ingredients')
      .values([
        {
          product_id: productId,
          stock_item_id: stockItemId,
          quantity_required: '0.1250',
        },
        {
          product_id: multiIngredientProductId,
          stock_item_id: stockItemId,
          quantity_required: '0.2000',
        },
        {
          product_id: multiIngredientProductId,
          stock_item_id: secondStockItemId,
          quantity_required: '0.5000',
        },
      ])
      .execute();

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
    deniedApp = deniedModule.createNestApplication();
    await deniedApp.init();
  }, 30000);

  beforeEach(async () => {
    await clearSales();
    await setStock('5.0000');
  });

  afterAll(async () => {
    if (db && userIds.length) {
      await clearSales();
      await db
        .deleteFrom('branch_inventory')
        .where('branch_id', 'in', branchIds)
        .execute();
      await db
        .deleteFrom('product_ingredients')
        .where('product_id', 'in', productIds)
        .execute();
      await db
        .deleteFrom('branch_products')
        .where('branch_id', 'in', branchIds)
        .execute();
      await db
        .deleteFrom('auth.branch_users')
        .where('user_id', 'in', userIds)
        .execute();
      await db.deleteFrom('products').where('id', 'in', productIds).execute();
      await db
        .deleteFrom('stock_items')
        .where('id', 'in', stockItemIds)
        .execute();
      await db.deleteFrom('branches').where('id', 'in', branchIds).execute();
      await db.deleteFrom('auth.users').where('id', 'in', userIds).execute();
      await db.deleteFrom('auth.roles').where('id', 'in', roleIds).execute();
    }
    await Promise.all([app?.close(), deniedApp?.close()]);
  });

  it('enforces sales permission and assigned branch scope', async () => {
    const denied = await request(deniedApp.getHttpServer()).get(
      `/branches/${branchId}/sales`,
    );
    const outsideScope = await request(app.getHttpServer()).get(
      `/branches/${otherBranchId}/sales`,
    );
    expect(denied.status).toBe(403);
    expect(outsideScope.status).toBe(403);
  });

  it('validates sale input and requires a UUID idempotency key', async () => {
    const missingKey = await request(app.getHttpServer())
      .post(`/branches/${branchId}/sales`)
      .send({
        tender_method: 'cash',
        items: [{ product_id: productId, quantity: '1' }],
      });
    const invalidQuantity = await request(app.getHttpServer())
      .post(`/branches/${branchId}/sales`)
      .set('Idempotency-Key', randomUUID())
      .send({
        tender_method: 'cash',
        items: [{ product_id: productId, quantity: '1e-2' }],
      });
    const duplicateProduct = await request(app.getHttpServer())
      .post(`/branches/${branchId}/sales`)
      .set('Idempotency-Key', randomUUID())
      .send({
        tender_method: 'cash',
        items: [
          { product_id: productId, quantity: '1' },
          { product_id: productId, quantity: '2' },
        ],
      });
    const unknownField = await request(app.getHttpServer())
      .post(`/branches/${branchId}/sales`)
      .set('Idempotency-Key', randomUUID())
      .send({
        tender_method: 'cash',
        items: [{ product_id: productId, quantity: '1' }],
        total_amount: '0.01',
      });

    expect(missingKey.status).toBe(400);
    expect(invalidQuantity.status).toBe(400);
    expect(duplicateProduct.status).toBe(400);
    expect(unknownField.status).toBe(400);
  });

  it('posts exact sale snapshots, consumes stock once, and returns the same sale on retry', async () => {
    const idempotencyKey = randomUUID();
    const payload = {
      tender_method: 'cash',
      items: [{ product_id: productId, quantity: '0.5000' }],
    };
    const [first, retry] = await Promise.all([
      request(app.getHttpServer())
        .post(`/branches/${branchId}/sales`)
        .set('Idempotency-Key', idempotencyKey)
        .send(payload),
      request(app.getHttpServer())
        .post(`/branches/${branchId}/sales`)
        .set('Idempotency-Key', idempotencyKey)
        .send(payload),
    ]);

    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(retry.body.id).toBe(first.body.id);
    expect(first.body).toMatchObject({
      branch_id: branchId,
      cashier_user_id: actorUserId,
      status: 'COMPLETED',
      tender_method: 'cash',
      total_amount: '4.625',
      items: [
        {
          product_id: productId,
          product_name_snapshot: `Sales product ${suffix}`,
          quantity: '0.5',
          unit_price: '9.2500',
          line_total: '4.625',
        },
      ],
    });
    await expect(
      db
        .selectFrom('branch_inventory')
        .select('quantity_on_hand')
        .where('branch_id', '=', branchId)
        .where('stock_item_id', '=', stockItemId)
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({ quantity_on_hand: '4.9375' });

    const movements = await db
      .selectFrom('inventory_movements')
      .select(['movement_type', 'quantity_delta', 'sale_item_consumption_id'])
      .where('actor_user_id', '=', actorUserId)
      .where('movement_type', '=', 'SALE')
      .execute();
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({
      quantity_delta: '-0.0625',
      sale_item_consumption_id: expect.any(String),
    });

    const changedRetry = await request(app.getHttpServer())
      .post(`/branches/${branchId}/sales`)
      .set('Idempotency-Key', idempotencyKey)
      .send({
        tender_method: 'card',
        items: [{ product_id: productId, quantity: '1' }],
      });
    expect(changedRetry.status).toBe(409);

    const list = await request(app.getHttpServer()).get(
      `/branches/${branchId}/sales?page=1&page_size=10`,
    );
    const detail = await request(app.getHttpServer()).get(
      `/branches/${branchId}/sales/${first.body.id}`,
    );
    expect(list.status).toBe(200);
    expect(list.body.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: first.body.id })]),
    );
    expect(detail.status).toBe(200);
    expect(detail.body.items).toHaveLength(1);
  });

  it('rolls back unavailable, recipe-less, and insufficient-stock sales', async () => {
    await db
      .updateTable('branch_products')
      .set({ is_available: false })
      .where('branch_id', '=', branchId)
      .where('product_id', '=', productId)
      .execute();
    const unavailable = await postSale(randomUUID());
    await db
      .updateTable('branch_products')
      .set({ is_available: true })
      .where('branch_id', '=', branchId)
      .where('product_id', '=', productId)
      .execute();
    const noRecipe = await postSale(randomUUID(), noRecipeProductId);
    await setStock('5.0000', '0.1000');
    const insufficient = await request(app.getHttpServer())
      .post(`/branches/${branchId}/sales`)
      .set('Idempotency-Key', randomUUID())
      .send({
        tender_method: 'cash',
        items: [{ product_id: multiIngredientProductId, quantity: '1' }],
      });

    expect(unavailable.status).toBe(409);
    expect(noRecipe.status).toBe(409);
    expect(insufficient.status).toBe(409);
    const persisted = await db
      .selectFrom('sales')
      .select((eb) => eb.fn.countAll<number>().as('total'))
      .where('cashier_user_id', '=', actorUserId)
      .executeTakeFirstOrThrow();
    expect(Number(persisted.total)).toBe(0);
    const movements = await db
      .selectFrom('inventory_movements')
      .select('id')
      .where('actor_user_id', '=', actorUserId)
      .execute();
    expect(movements).toHaveLength(0);
    const balances = await db
      .selectFrom('branch_inventory')
      .select(['stock_item_id', 'quantity_on_hand'])
      .where('branch_id', '=', branchId)
      .where('stock_item_id', 'in', [stockItemId, secondStockItemId])
      .execute();
    expect(balances).toEqual(
      expect.arrayContaining([
        { stock_item_id: stockItemId, quantity_on_hand: '5.0000' },
        { stock_item_id: secondStockItemId, quantity_on_hand: '0.1000' },
      ]),
    );
  });

  it('prices multiple products and aggregates shared recipe stock exactly', async () => {
    const response = await request(app.getHttpServer())
      .post(`/branches/${branchId}/sales`)
      .set('Idempotency-Key', randomUUID())
      .send({
        tender_method: 'cash',
        items: [
          { product_id: productId, quantity: '0.5000' },
          { product_id: multiIngredientProductId, quantity: '2' },
        ],
      });

    expect(response.status).toBe(201);
    expect(response.body.total_amount).toBe('10.625');
    expect(response.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          product_id: productId,
          quantity: '0.5',
          unit_price: '9.2500',
          line_total: '4.625',
        }),
        expect.objectContaining({
          product_id: multiIngredientProductId,
          quantity: '2',
          unit_price: '3.00',
          line_total: '6',
        }),
      ]),
    );

    const balances = await db
      .selectFrom('branch_inventory')
      .select(['stock_item_id', 'quantity_on_hand'])
      .where('branch_id', '=', branchId)
      .where('stock_item_id', 'in', [stockItemId, secondStockItemId])
      .execute();
    expect(balances).toEqual(
      expect.arrayContaining([
        { stock_item_id: stockItemId, quantity_on_hand: '4.5375' },
        { stock_item_id: secondStockItemId, quantity_on_hand: '9.0000' },
      ]),
    );

    const movements = await db
      .selectFrom('inventory_movements')
      .select(['stock_item_id', 'quantity_delta'])
      .where('actor_user_id', '=', actorUserId)
      .where('movement_type', '=', 'SALE')
      .execute();
    expect(movements).toHaveLength(3);
    expect(movements).toEqual(
      expect.arrayContaining([
        { stock_item_id: stockItemId, quantity_delta: '-0.0625' },
        { stock_item_id: stockItemId, quantity_delta: '-0.4' },
        { stock_item_id: secondStockItemId, quantity_delta: '-1' },
      ]),
    );
  });

  it('serializes competing sales so branch inventory cannot go negative', async () => {
    await setStock('0.0625');
    const [first, second] = await Promise.all([
      postSale(randomUUID(), productId, '0.5'),
      postSale(randomUUID(), productId, '0.5'),
    ]);
    expect([first.status, second.status].sort((a, b) => a - b)).toEqual([
      201, 409,
    ]);
    await expect(
      db
        .selectFrom('branch_inventory')
        .select('quantity_on_hand')
        .where('branch_id', '=', branchId)
        .where('stock_item_id', '=', stockItemId)
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({ quantity_on_hand: '0.0000' });
    const sales = await db
      .selectFrom('sales')
      .select('id')
      .where('cashier_user_id', '=', actorUserId)
      .execute();
    expect(sales).toHaveLength(1);
  });

  it('completes concurrent branch adjustments and sales without deadlock', async () => {
    const pairs = await Promise.all(
      Array.from({ length: 8 }, async () =>
        Promise.all([
          postSale(randomUUID()),
          request(app.getHttpServer())
            .post(`/inventory/branches/${branchId}/adjustments`)
            .set('Idempotency-Key', randomUUID())
            .send({
              stock_item_id: stockItemId,
              quantity_delta: '0.0100',
              reason: 'Concurrent POS adjustment regression',
            }),
        ]),
      ),
    );
    const statuses = pairs.flatMap((pair) => pair.map(({ status }) => status));
    expect(statuses).toEqual(Array.from({ length: 16 }, () => 201));

    const balance = await db
      .selectFrom('branch_inventory')
      .select('quantity_on_hand')
      .where('branch_id', '=', branchId)
      .where('stock_item_id', '=', stockItemId)
      .executeTakeFirstOrThrow();
    expect(balance.quantity_on_hand).toBe('4.5800');
  }, 30000);

  it('voids with a reason and posts one exact reversal, with idempotent retry', async () => {
    const saleKey = randomUUID();
    const sale = await postSale(saleKey, productId, '0.5');
    expect(sale.status).toBe(201);
    const saleId = sale.body.id as string;
    const voidKey = randomUUID();
    const voidPayload = { reason: 'Cashier entered the wrong item' };
    const [voided, retry] = await Promise.all([
      request(app.getHttpServer())
        .post(`/branches/${branchId}/sales/${saleId}/void`)
        .set('Idempotency-Key', voidKey)
        .send(voidPayload),
      request(app.getHttpServer())
        .post(`/branches/${branchId}/sales/${saleId}/void`)
        .set('Idempotency-Key', voidKey)
        .send(voidPayload),
    ]);
    expect(voided.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(voided.body.id).toBe(saleId);
    expect(voided.body.status).toBe('VOIDED');

    const emptyReason = await request(app.getHttpServer())
      .post(`/branches/${branchId}/sales/${saleId}/void`)
      .set('Idempotency-Key', randomUUID())
      .send({ reason: '   ' });
    const newVoidKey = await request(app.getHttpServer())
      .post(`/branches/${branchId}/sales/${saleId}/void`)
      .set('Idempotency-Key', randomUUID())
      .send({ reason: 'Another reason' });
    expect(emptyReason.status).toBe(400);
    expect(newVoidKey.status).toBe(409);

    const inventory = await db
      .selectFrom('branch_inventory')
      .select('quantity_on_hand')
      .where('branch_id', '=', branchId)
      .where('stock_item_id', '=', stockItemId)
      .executeTakeFirstOrThrow();
    expect(inventory.quantity_on_hand).toBe('5.0000');
    const movements = await db
      .selectFrom('inventory_movements')
      .select([
        'movement_type',
        'quantity_delta',
        'reason',
        'reversal_of_movement_id',
      ])
      .where('actor_user_id', '=', actorUserId)
      .orderBy('created_at')
      .execute();
    expect(movements).toEqual([
      expect.objectContaining({
        movement_type: 'SALE',
        quantity_delta: '-0.0625',
      }),
      expect.objectContaining({
        movement_type: 'SALE_VOID',
        quantity_delta: '0.0625',
        reason: 'Cashier entered the wrong item',
        reversal_of_movement_id: expect.any(String),
      }),
    ]);
  });

  it('does not partially void a sale when a consumption movement is missing', async () => {
    const sale = await postSale(randomUUID(), multiIngredientProductId, '2');
    expect(sale.status).toBe(201);

    const missingMovementConsumption = db
      .selectFrom('sale_item_consumptions as sic')
      .innerJoin('sale_items as si', 'si.id', 'sic.sale_item_id')
      .select('sic.id')
      .where('si.sale_id', '=', sale.body.id as string)
      .where('sic.stock_item_id', '=', secondStockItemId);
    await db
      .deleteFrom('inventory_movements')
      .where('sale_item_consumption_id', 'in', missingMovementConsumption)
      .execute();

    const response = await request(app.getHttpServer())
      .post(`/branches/${branchId}/sales/${sale.body.id}/void`)
      .set('Idempotency-Key', randomUUID())
      .send({ reason: 'Check the complete movement history first' });

    expect(response.status).toBe(500);
    await expect(
      db
        .selectFrom('sales')
        .select('status')
        .where('id', '=', sale.body.id as string)
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({ status: 'COMPLETED' });
    await expect(
      db
        .selectFrom('inventory_movements')
        .select('id')
        .where('movement_type', '=', 'SALE_VOID')
        .where('reversal_of_movement_id', 'in', (query) =>
          query
            .selectFrom('inventory_movements as original')
            .innerJoin(
              'sale_item_consumptions as consumption',
              'consumption.id',
              'original.sale_item_consumption_id',
            )
            .innerJoin(
              'sale_items as sale_item',
              'sale_item.id',
              'consumption.sale_item_id',
            )
            .select('original.id')
            .where('sale_item.sale_id', '=', sale.body.id as string)
            .where('original.movement_type', '=', 'SALE'),
        )
        .execute(),
    ).resolves.toHaveLength(0);
    await expect(
      db
        .selectFrom('branch_inventory')
        .select(['stock_item_id', 'quantity_on_hand'])
        .where('branch_id', '=', branchId)
        .where('stock_item_id', 'in', [stockItemId, secondStockItemId])
        .execute(),
    ).resolves.toEqual(
      expect.arrayContaining([
        { stock_item_id: stockItemId, quantity_on_hand: '4.6000' },
        { stock_item_id: secondStockItemId, quantity_on_hand: '9.0000' },
      ]),
    );
  });

  it('rejects a concurrently reused void key for a different sale', async () => {
    const firstSale = await postSale(randomUUID());
    const secondSale = await postSale(randomUUID());
    const idempotencyKey = randomUUID();
    const input = { reason: 'Duplicate key race' };
    const [firstVoid, secondVoid] = await Promise.all([
      request(app.getHttpServer())
        .post(`/branches/${branchId}/sales/${firstSale.body.id}/void`)
        .set('Idempotency-Key', idempotencyKey)
        .send(input),
      request(app.getHttpServer())
        .post(`/branches/${branchId}/sales/${secondSale.body.id}/void`)
        .set('Idempotency-Key', idempotencyKey)
        .send(input),
    ]);

    expect([firstVoid.status, secondVoid.status].sort((a, b) => a - b)).toEqual(
      [201, 409],
    );
    const statuses = await db
      .selectFrom('sales')
      .select('status')
      .where('cashier_user_id', '=', actorUserId)
      .orderBy('id')
      .execute();
    expect(statuses.map(({ status }) => status).sort()).toEqual([
      'COMPLETED',
      'VOIDED',
    ]);
    const reversals = await db
      .selectFrom('inventory_movements')
      .select('id')
      .where('actor_user_id', '=', actorUserId)
      .where('movement_type', '=', 'SALE_VOID')
      .execute();
    expect(reversals).toHaveLength(1);
  });

  async function postSale(
    idempotencyKey: string,
    selectedProductId = productId,
    quantity = '0.5',
  ) {
    return request(app.getHttpServer())
      .post(`/branches/${branchId}/sales`)
      .set('Idempotency-Key', idempotencyKey)
      .send({
        tender_method: 'cash',
        items: [{ product_id: selectedProductId, quantity }],
      });
  }

  async function setStock(firstQuantity: string, secondQuantity = '10.0000') {
    for (const [stockItem, quantity] of [
      [stockItemId, firstQuantity],
      [secondStockItemId, secondQuantity],
    ]) {
      await db
        .insertInto('branch_inventory')
        .values({
          branch_id: branchId,
          stock_item_id: stockItem,
          quantity_on_hand: quantity,
        })
        .onConflict((conflict) =>
          conflict.columns(['branch_id', 'stock_item_id']).doUpdateSet({
            quantity_on_hand: quantity,
          }),
        )
        .execute();
    }
  }

  async function clearSales() {
    await db
      .deleteFrom('inventory_movements')
      .where('actor_user_id', '=', actorUserId)
      .execute();
    const sales = await db
      .selectFrom('sales')
      .select('id')
      .where('cashier_user_id', '=', actorUserId)
      .execute();
    const saleIds = sales.map(({ id }) => id);
    if (!saleIds.length) return;

    await db
      .deleteFrom('sale_events')
      .where('sale_id', 'in', saleIds)
      .execute();
    const lines = await db
      .selectFrom('sale_items')
      .select('id')
      .where('sale_id', 'in', saleIds)
      .execute();
    const lineIds = lines.map(({ id }) => id);
    if (lineIds.length)
      await db
        .deleteFrom('sale_item_consumptions')
        .where('sale_item_id', 'in', lineIds)
        .execute();
    await db.deleteFrom('sale_items').where('sale_id', 'in', saleIds).execute();
    await db.deleteFrom('sales').where('id', 'in', saleIds).execute();
  }

  async function createUser(roleId: string, label: string): Promise<string> {
    const user = await db
      .insertInto('auth.users')
      .values({
        email: `sales-${label}-${suffix}@example.invalid`,
        full_name: `Sales ${label} ${suffix}`,
        contact_number: `SLS${suffix.slice(0, 12)}${label === 'cashier' ? 'C' : 'D'}`,
        hashed_password: 'not-used-by-test-auth-guard',
        role_id: roleId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return user.id;
  }

  async function createBranch(name: string): Promise<string> {
    const branch = await db
      .insertInto('branches')
      .values({
        code: `SL-${randomUUID().slice(0, 8)}`.toUpperCase(),
        branch_name: name,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    branchIds.push(branch.id);
    return branch.id;
  }
});
