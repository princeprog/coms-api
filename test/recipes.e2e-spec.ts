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
import { AuthGatewayGuard } from '../src/common/guards/auth-gateway.guard';
import { AuthGuard } from '../src/common/guards/auth.guard';
import { AppModule } from '../src/app.module';
import { DATABASE } from '../src/database/database.module';
import type { DB } from '../src/database/db';

type TestRequest = { user?: { id: string } };

describe('recipe routes (e2e)', () => {
  const suffix = randomUUID();
  const productIds: string[] = [];
  const stockItemIds: string[] = [];
  const roleIds: string[] = [];
  const userIds: string[] = [];
  let actorUserId: string;
  let deniedUserId: string;
  let app: INestApplication<App>;
  let deniedApp: INestApplication<App>;
  let db: Kysely<DB>;
  let productId: string;
  let activeStockItemId: string;
  let secondStockItemId: string;
  let inactiveStockItemId: string;

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
        code: `RECIPE_TEST_${suffix.replaceAll('-', '').slice(0, 16).toUpperCase()}`,
        role_name: `Recipe Test ${suffix}`,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    roleIds.push(role.id);
    const deniedRole = await db
      .insertInto('auth.roles')
      .values({
        code: `RECIPE_DENIED_${suffix.replaceAll('-', '').slice(0, 14).toUpperCase()}`,
        role_name: `Recipe Denied ${suffix}`,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    roleIds.push(deniedRole.id);

    actorUserId = await createUser(role.id, 'writer');
    deniedUserId = await createUser(deniedRole.id, 'reader');
    userIds.push(actorUserId, deniedUserId);

    const permissions = await db
      .selectFrom('auth.permissions')
      .select('id')
      .where('module_key', '=', 'recipes')
      .where('action_key', 'in', ['read', 'create', 'update'])
      .execute();
    await db
      .insertInto('auth.role_permissions')
      .values(
        permissions.map(({ id }) => ({ role_id: role.id, permission_id: id })),
      )
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

    const product = await db
      .insertInto('products')
      .values({ product_name: `Recipe Product ${suffix}` })
      .returning('id')
      .executeTakeFirstOrThrow();
    productId = product.id;
    productIds.push(productId);

    activeStockItemId = await createStockItem(`Active flour ${suffix}`);
    secondStockItemId = await createStockItem(`Active oil ${suffix}`);
    inactiveStockItemId = await createStockItem(`Inactive salt ${suffix}`);
    stockItemIds.push(
      activeStockItemId,
      secondStockItemId,
      inactiveStockItemId,
    );
    await db
      .updateTable('stock_items')
      .set({ is_active: false })
      .where('id', '=', inactiveStockItemId)
      .execute();
  }, 30000);

  afterAll(async () => {
    if (db && productIds.length)
      await db
        .deleteFrom('product_ingredients')
        .where('product_id', 'in', productIds)
        .execute();
    if (db && productIds.length)
      await db.deleteFrom('products').where('id', 'in', productIds).execute();
    if (db && stockItemIds.length)
      await db
        .deleteFrom('stock_items')
        .where('id', 'in', stockItemIds)
        .execute();
    if (db && userIds.length)
      await db.deleteFrom('auth.users').where('id', 'in', userIds).execute();
    if (db && roleIds.length)
      await db.deleteFrom('auth.roles').where('id', 'in', roleIds).execute();
    await Promise.all([app?.close(), deniedApp?.close()]);
  });

  it('denies a valid session without recipe permission', async () => {
    const response = await request(deniedApp.getHttpServer()).get(
      `/products/${productId}/recipe`,
    );
    expect(response.status).toBe(403);
    expect(response.body.message).toBe('Permission required');
  });

  it('returns an empty recipe for a product that has no recipe yet', async () => {
    const emptyProduct = await db
      .insertInto('products')
      .values({ product_name: `Unconfigured Recipe Product ${suffix}` })
      .returning('id')
      .executeTakeFirstOrThrow();
    productIds.push(emptyProduct.id);

    const response = await request(app.getHttpServer()).get(
      `/products/${emptyProduct.id}/recipe`,
    );
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      product: { id: emptyProduct.id },
      items: [],
    });
  });

  it('validates product ids, nonempty lines, positive decimal strings, and unique stock items', async () => {
    const invalidId = await request(app.getHttpServer()).get(
      '/products/not-a-uuid/recipe',
    );
    const empty = await request(app.getHttpServer())
      .post(`/products/${productId}/recipe`)
      .send({ items: [] });
    const zero = await request(app.getHttpServer())
      .post(`/products/${productId}/recipe`)
      .send({
        items: [{ stock_item_id: activeStockItemId, quantity_required: '0' }],
      });
    const invalidDecimal = await request(app.getHttpServer())
      .post(`/products/${productId}/recipe`)
      .send({
        items: [
          { stock_item_id: activeStockItemId, quantity_required: '1e-3' },
        ],
      });
    const duplicate = await request(app.getHttpServer())
      .post(`/products/${productId}/recipe`)
      .send({
        items: [
          { stock_item_id: activeStockItemId, quantity_required: '1' },
          { stock_item_id: activeStockItemId, quantity_required: '2' },
        ],
      });
    expect(invalidId.status).toBe(400);
    expect(empty.status).toBe(400);
    expect(zero.status).toBe(400);
    expect(invalidDecimal.status).toBe(400);
    expect(duplicate.status).toBe(400);
  });

  it('creates, reads, and replaces a recipe while preserving exact quantities', async () => {
    const created = await request(app.getHttpServer())
      .post(`/products/${productId}/recipe`)
      .send({
        items: [
          { stock_item_id: activeStockItemId, quantity_required: '0.0250' },
          { stock_item_id: secondStockItemId, quantity_required: '1.500' },
        ],
      });
    expect(created.status).toBe(201);
    expect(created.body.product).toMatchObject({ id: productId });
    expect(created.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stock_item_id: activeStockItemId,
          quantity_required: '0.0250',
          stock_item_name: `Active flour ${suffix}`,
          unit: 'kg',
        }),
        expect.objectContaining({
          stock_item_id: secondStockItemId,
          quantity_required: '1.500',
        }),
      ]),
    );

    const read = await request(app.getHttpServer()).get(
      `/products/${productId}/recipe`,
    );
    expect(read.status).toBe(200);
    expect(read.body.items).toHaveLength(2);

    const duplicateCreate = await request(app.getHttpServer())
      .post(`/products/${productId}/recipe`)
      .send({
        items: [{ stock_item_id: activeStockItemId, quantity_required: '3' }],
      });
    expect(duplicateCreate.status).toBe(409);

    const updated = await request(app.getHttpServer())
      .put(`/products/${productId}/recipe`)
      .send({
        items: [
          { stock_item_id: secondStockItemId, quantity_required: '2.75' },
        ],
      });
    expect(updated.status).toBe(200);
    expect(updated.body.items).toEqual([
      expect.objectContaining({
        stock_item_id: secondStockItemId,
        quantity_required: '2.75',
      }),
    ]);
  });

  it('preserves the saved recipe when inactive ingredients are submitted', async () => {
    const before = await request(app.getHttpServer()).get(
      `/products/${productId}/recipe`,
    );
    const response = await request(app.getHttpServer())
      .put(`/products/${productId}/recipe`)
      .send({
        items: [
          { stock_item_id: activeStockItemId, quantity_required: '9' },
          { stock_item_id: inactiveStockItemId, quantity_required: '1' },
        ],
      });
    const after = await request(app.getHttpServer()).get(
      `/products/${productId}/recipe`,
    );
    expect(response.status).toBe(404);
    expect(after.body.items).toEqual(before.body.items);
  });

  it('rejects updates before a recipe exists and rejects unknown request fields', async () => {
    const emptyProduct = await db
      .insertInto('products')
      .values({ product_name: `Empty Recipe Product ${suffix}` })
      .returning('id')
      .executeTakeFirstOrThrow();
    productIds.push(emptyProduct.id);
    const update = await request(app.getHttpServer())
      .put(`/products/${emptyProduct.id}/recipe`)
      .send({
        items: [{ stock_item_id: activeStockItemId, quantity_required: '1' }],
      });
    const unknown = await request(app.getHttpServer())
      .post(`/products/${emptyProduct.id}/recipe`)
      .send({
        items: [{ stock_item_id: activeStockItemId, quantity_required: '1' }],
        unexpected: true,
      });
    expect(update.status).toBe(409);
    expect(unknown.status).toBe(400);
  });

  async function createUser(roleId: string, label: string): Promise<string> {
    const user = await db
      .insertInto('auth.users')
      .values({
        email: `recipe-${label}-${suffix}@example.invalid`,
        full_name: `Recipe ${label} ${suffix}`,
        contact_number: `RCP${suffix.slice(0, 12)}${label === 'writer' ? 'W' : 'D'}`,
        hashed_password: 'not-used-by-test-auth-guard',
        role_id: roleId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return user.id;
  }

  async function createStockItem(name: string): Promise<string> {
    const stockItem = await db
      .insertInto('stock_items')
      .values({ stock_item_name: name, category: 'Recipe test', unit: 'kg' })
      .returning('id')
      .executeTakeFirstOrThrow();
    return stockItem.id;
  }
});
