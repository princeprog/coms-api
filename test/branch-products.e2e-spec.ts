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
      .values({ product_name: `Branch Offer Product ${suffix}` })
      .returning('id')
      .executeTakeFirstOrThrow();
    productId = product.id;
    productIds.push(productId);
    const inactiveProduct = await db
      .insertInto('products')
      .values({
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
    if (db && productIds.length)
      await db.deleteFrom('products').where('id', 'in', productIds).execute();
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

  it('validates branch and product ids, pagination, exact decimal prices, and availability', async () => {
    const invalidBranch = await request(app.getHttpServer()).get(
      '/branches/not-a-uuid/products',
    );
    const invalidProduct = await request(app.getHttpServer()).get(
      `/branches/${branchId}/products/not-a-uuid`,
    );
    const invalidPage = await request(app.getHttpServer()).get(
      `/branches/${branchId}/products?page=0`,
    );
    const invalidAvailabilityFilter = await request(app.getHttpServer()).get(
      `/branches/${branchId}/products?is_available=yes`,
    );
    const negativePrice = await request(app.getHttpServer())
      .post(`/branches/${branchId}/products`)
      .send({ product_id: productId, price: '-1' });
    const exponentPrice = await request(app.getHttpServer())
      .post(`/branches/${branchId}/products`)
      .send({ product_id: productId, price: '1e2' });
    const unknownField = await request(app.getHttpServer())
      .post(`/branches/${branchId}/products`)
      .send({ product_id: productId, price: '1.25', extra: true });
    const invalidAvailability = await request(app.getHttpServer())
      .post(`/branches/${branchId}/products/${productId}/availability`)
      .send({ is_available: 'true' });

    expect(invalidBranch.status).toBe(400);
    expect(invalidProduct.status).toBe(400);
    expect(invalidPage.status).toBe(400);
    expect(invalidAvailabilityFilter.status).toBe(400);
    expect(negativePrice.status).toBe(400);
    expect(exponentPrice.status).toBe(400);
    expect(unknownField.status).toBe(400);
    expect(invalidAvailability.status).toBe(400);
  });

  it('creates, reads, searches, and updates a branch offering with exact price strings', async () => {
    const created = await request(app.getHttpServer())
      .post(`/branches/${branchId}/products`)
      .send({ product_id: productId, price: '149.5000' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      branch_id: branchId,
      product_id: productId,
      price: '149.5000',
      is_available: true,
      product_name: `Branch Offer Product ${suffix}`,
      product_is_active: true,
    });

    const duplicate = await request(app.getHttpServer())
      .post(`/branches/${branchId}/products`)
      .send({ product_id: productId, price: '150' });
    expect(duplicate.status).toBe(409);

    const detail = await request(app.getHttpServer()).get(
      `/branches/${branchId}/products/${productId}`,
    );
    expect(detail.status).toBe(200);
    expect(detail.body.price).toBe('149.5000');

    const listed = await request(app.getHttpServer()).get(
      `/branches/${branchId}/products?search=${encodeURIComponent(suffix)}&is_available=true&page=1&page_size=10`,
    );
    expect(listed.status).toBe(200);
    expect(listed.body.total).toBe(1);
    expect(listed.body.items[0].product_id).toBe(productId);

    const updated = await request(app.getHttpServer())
      .patch(`/branches/${branchId}/products/${productId}`)
      .send({ price: '152.75' });
    expect(updated.status).toBe(200);
    expect(updated.body.price).toBe('152.75');
  });

  it('changes availability through its separately permissioned transition', async () => {
    const unavailable = await request(app.getHttpServer())
      .post(`/branches/${branchId}/products/${productId}/availability`)
      .send({ is_available: false });
    expect(unavailable.status).toBe(201);
    expect(unavailable.body.is_available).toBe(false);

    const availableList = await request(app.getHttpServer()).get(
      `/branches/${branchId}/products?is_available=true`,
    );
    expect(availableList.body.total).toBe(0);

    const available = await request(app.getHttpServer())
      .post(`/branches/${branchId}/products/${productId}/availability`)
      .send({ is_available: true });
    expect(available.status).toBe(201);
    expect(available.body.is_available).toBe(true);
  });

  it('requires active products for new offers and returns missing offers as not found', async () => {
    const inactiveProduct = await request(app.getHttpServer())
      .post(`/branches/${branchId}/products`)
      .send({ product_id: inactiveProductId, price: '10' });
    const missing = await request(app.getHttpServer()).get(
      `/branches/${branchId}/products/${randomUUID()}`,
    );
    expect(inactiveProduct.status).toBe(409);
    expect(missing.status).toBe(404);
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
