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

describe('branch product routes (e2e)', () => {
  const suffix = randomUUID();
  const roleIds: string[] = [];
  const userIds: string[] = [];
  const branchIds: string[] = [];
  const productIds: string[] = [];
  let actorUserId: string;
  let deniedUserId: string;
  let branchId: string;
  let otherBranchId: string;
  let productId: string;
  let ingredientId: string;
  let inactiveProductId: string;
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
        code: `BRANCH_PRODUCT_TEST_${suffix.replaceAll('-', '').slice(0, 12).toUpperCase()}`,
        role_name: `Branch Product Test ${suffix}`,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    roleIds.push(role.id);
    const deniedRole = await db
      .insertInto('auth.roles')
      .values({
        code: `BRANCH_PRODUCT_DENIED_${suffix.replaceAll('-', '').slice(0, 8).toUpperCase()}`,
        role_name: `Branch Product Denied ${suffix}`,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    roleIds.push(deniedRole.id);

    actorUserId = await createUser(role.id, 'writer');
    deniedUserId = await createUser(deniedRole.id, 'denied');
    userIds.push(actorUserId, deniedUserId);

    const permissions = await db
      .selectFrom('auth.permissions')
      .select('id')
      .where('module_key', '=', 'branch_products')
      .where('action_key', 'in', [
        'read',
        'create',
        'update',
        'availability_update',
      ])
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

    branchId = await createBranch(`Branch Product ${suffix}`);
    otherBranchId = await createBranch(`Other Branch Product ${suffix}`);
    await db
      .insertInto('auth.branch_users')
      .values({ user_id: actorUserId, branch_id: branchId })
      .execute();

    const product = await db
      .insertInto('products')
      .values({
        price: '19.125',
        product_name: `Branch Offer Product ${suffix}`,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    productId = product.id;
    productIds.push(productId);
    ingredientId = (
      await db
        .insertInto('stock_items')
        .values({
          stock_item_name: 'Offer ingredient ' + suffix,
          usage_types: ['INGREDIENT'],
          category: 'Other',
          unit: 'pcs',
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    await db
      .insertInto('product_ingredients')
      .values({
        product_id: productId,
        stock_item_id: ingredientId,
        quantity_required: '1',
      })
      .execute();
    await db
      .insertInto('branch_product_prices')
      .values({
        branch_id: branchId,
        product_id: productId,
        price: '149.5',
        updated_by_user_id: actorUserId,
      })
      .execute();
    const inactiveProduct = await db
      .insertInto('products')
      .values({
        price: '19.125',
        product_name: `Inactive Offer Product ${suffix}`,
        is_active: false,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    inactiveProductId = inactiveProduct.id;
    productIds.push(inactiveProductId);
  }, 30000);

  afterAll(async () => {
    if (db && branchIds.length)
      await db
        .deleteFrom('auth.branch_users')
        .where('branch_id', 'in', branchIds)
        .execute();
    if (db && branchIds.length)
      await db
        .deleteFrom('branch_products')
        .where('branch_id', 'in', branchIds)
        .execute();
    if (db && productIds.length) {
      await db
        .deleteFrom('branch_product_prices')
        .where('product_id', 'in', productIds)
        .execute();
      await db
        .deleteFrom('product_ingredients')
        .where('product_id', 'in', productIds)
        .execute();
    }
    if (db && productIds.length)
      await db
        .deleteFrom('branch_product_prices')
        .where('product_id', 'in', productIds)
        .execute();
    await db.deleteFrom('products').where('id', 'in', productIds).execute();
    if (db && ingredientId)
      await db
        .deleteFrom('stock_items')
        .where('id', '=', ingredientId)
        .execute();
    if (db && branchIds.length)
      await db.deleteFrom('branches').where('id', 'in', branchIds).execute();
    if (db && userIds.length)
      await db.deleteFrom('auth.users').where('id', 'in', userIds).execute();
    if (db && roleIds.length)
      await db.deleteFrom('auth.roles').where('id', 'in', roleIds).execute();
    await Promise.all([app?.close(), deniedApp?.close()]);
  });

  it('denies access without permission and blocks an assigned user from another branch', async () => {
    const denied = await request(deniedApp.getHttpServer()).get(
      `/branches/${branchId}/products`,
    );
    expect(denied.status).toBe(403);
    expect(denied.body.message).toBe('Permission required');

    const outOfScope = await request(app.getHttpServer()).get(
      `/branches/${otherBranchId}/products`,
    );
    expect(outOfScope.status).toBe(403);
    expect(outOfScope.body.message).toBe('Branch access required');
  });

  it('validates branch and product ids and pagination on reads', async () => {
    expect(
      (await request(app.getHttpServer()).get('/branches/bad-id/products'))
        .status,
    ).toBe(400);
    expect(
      (
        await request(app.getHttpServer()).get(
          `/branches/${branchId}/products?page=0`,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app.getHttpServer()).get(
          `/branches/${branchId}/products/bad-id`,
        )
      ).status,
    ).toBe(400);
  });
  it('rejects menu mutations from custom staff with legacy grants', async () => {
    const endpoint = `/branches/${branchId}/products`;
    expect(
      (
        await request(app.getHttpServer())
          .post(endpoint)
          .send({ product_id: productId, service_types: ['TAKEAWAY'] })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app.getHttpServer())
          .post(`${endpoint}/${productId}/availability`)
          .send({ is_available: true })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app.getHttpServer())
          .patch(`${endpoint}/${productId}/services`)
          .send({ service_types: ['TAKEAWAY'] })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app.getHttpServer())
          .patch(`${endpoint}/${productId}`)
          .send({ price: '1', expected_revision: 1 })
      ).status,
    ).toBe(404);
  });
  it('returns a scoped, paginated menu and missing offerings as not found', async () => {
    const result = await request(app.getHttpServer()).get(
      `/branches/${branchId}/products?search=missing`,
    );
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ items: [], total: 0, page: 1 });
    expect(
      (
        await request(app.getHttpServer()).get(
          `/branches/${branchId}/products/${randomUUID()}`,
        )
      ).status,
    ).toBe(404);
  });
  async function createUser(roleId: string, label: string): Promise<string> {
    const user = await db
      .insertInto('auth.users')
      .values({
        email: `branch-product-${label}-${suffix}@example.invalid`,
        full_name: `Branch Product ${label} ${suffix}`,
        contact_number: `BPR${suffix.slice(0, 12)}${label === 'writer' ? 'W' : 'D'}`,
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
        code: `BP-${randomUUID().slice(0, 8)}`.toUpperCase(),
        branch_name: name,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    branchIds.push(branch.id);
    return branch.id;
  }
});
