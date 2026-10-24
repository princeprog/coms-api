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
  const roleIds: string[] = [];
  const userIds: string[] = [];
  let branchId: string;
  let otherBranchId: string;
  let inactiveBranchId: string | undefined;
  let actorUserId: string;
  let branchManagerUserId: string;
  let commissaryManagerUserId: string;
  let superAdminUserId: string;
  let scopedStockItemId: string;
  let authorizedUserId: string;
  let branchIds: string[] = [];
  let app: INestApplication<App>;
  let accessApp: INestApplication<App>;
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
      .selectFrom('coms_auth.users')
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

    const otherBranch = await db
      .insertInto('branches')
      .values({
        code: `INV-OTHER-${suffix}`,
        branch_name: `Other inventory ${suffix}`,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    otherBranchId = otherBranch.id;

    const roleToken = suffix.replaceAll('-', '').slice(0, 12).toUpperCase();
    const branchRole = await db
      .insertInto('coms_auth.roles')
      .values({
        code: `INV_BRANCH_${roleToken}`,
        role_name: `Inventory Branch ${suffix}`,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const commissaryRole = await db
      .insertInto('coms_auth.roles')
      .values({
        code: `INV_COMMISSARY_${roleToken}`,
        role_name: `Inventory Commissary ${suffix}`,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    roleIds.push(branchRole.id, commissaryRole.id);

    const inventoryPermissions = await db
      .selectFrom('coms_auth.permissions')
      .select(['id', 'action_key'])
      .where('module_key', '=', 'inventory')
      .where('action_key', 'in', [
        'read',
        'adjust',
        'commissary_read',
        'commissary_adjust',
      ])
      .execute();
    const permissionIds = new Map(
      inventoryPermissions.map(({ id, action_key }) => [action_key, id]),
    );
    if (permissionIds.size !== 4)
      throw new Error('Inventory permission catalog is incomplete');
    await db
      .insertInto('coms_auth.role_permissions')
      .values([
        {
          role_id: branchRole.id,
          permission_id: permissionIds.get('read')!,
        },
        {
          role_id: branchRole.id,
          permission_id: permissionIds.get('adjust')!,
        },
        {
          role_id: commissaryRole.id,
          permission_id: permissionIds.get('commissary_read')!,
        },
        {
          role_id: commissaryRole.id,
          permission_id: permissionIds.get('commissary_adjust')!,
        },
      ])
      .execute();

    const superAdminRole = await db
      .selectFrom('coms_auth.roles')
      .select('id')
      .where('code', '=', 'SUPER_ADMIN')
      .where('is_system', '=', true)
      .executeTakeFirstOrThrow();
    branchManagerUserId = await createUser(branchRole.id, 'branch');
    commissaryManagerUserId = await createUser(commissaryRole.id, 'commissary');
    superAdminUserId = await createUser(superAdminRole.id, 'super');
    userIds.push(
      branchManagerUserId,
      commissaryManagerUserId,
      superAdminUserId,
    );
    await db
      .insertInto('coms_auth.branch_users')
      .values({ user_id: branchManagerUserId, branch_id: branchId })
      .execute();
    scopedStockItemId = await createStockItem(`Scoped inventory ${suffix}`);
    stockItemIds.push(scopedStockItemId);

    authorizedUserId = branchManagerUserId;
    const accessModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideGuard(AuthGatewayGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(AuthGuard)
      .useValue({
        canActivate: (execution: ExecutionContext) => {
          execution.switchToHttp().getRequest<TestRequest>().user = {
            id: authorizedUserId,
          };
          return true;
        },
      })
      .compile();
    accessApp = accessModule.createNestApplication();
    accessApp.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await accessApp.init();
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
    if (otherBranchId) {
      await db.deleteFrom('branches').where('id', '=', otherBranchId).execute();
    }
    if (userIds.length) {
      await db
        .deleteFrom('coms_auth.users')
        .where('id', 'in', userIds)
        .execute();
    }
    if (roleIds.length) {
      await db
        .deleteFrom('coms_auth.roles')
        .where('id', 'in', roleIds)
        .execute();
    }
    await Promise.all([app.close(), accessApp.close(), guardedApp.close()]);
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

  it('limits branch inventory permissions to assigned branches', async () => {
    authorizedUserId = branchManagerUserId;
    const client = request(accessApp.getHttpServer());
    const assignedBalance = await client.get(`/inventory/branches/${branchId}`);
    const assignedMovements = await client.get(
      `/inventory/branches/${branchId}/movements`,
    );
    const branchAdjustment = await client
      .post(`/inventory/branches/${branchId}/adjustments`)
      .set('Idempotency-Key', randomUUID())
      .send({
        stock_item_id: scopedStockItemId,
        quantity_delta: '1',
        reason: 'Scoped branch authorization test',
      });
    const otherBranchBalance = await client
      .get(`/inventory/branches/${otherBranchId}`)
      .query({
        search: 'Flour',
        is_active: 'true',
        category: 'Baking',
      });
    const otherBranchAdjustment = await client
      .post(`/inventory/branches/${otherBranchId}/adjustments`)
      .set('Idempotency-Key', randomUUID())
      .send({
        stock_item_id: scopedStockItemId,
        quantity_delta: '1',
        reason: 'Out-of-scope authorization test',
      });
    const commissaryBalance = await client.get('/inventory/commissary');
    const commissaryMovements = await client.get(
      '/inventory/commissary/movements',
    );
    const commissaryAdjustment = await client
      .post('/inventory/commissary/adjustments')
      .set('Idempotency-Key', randomUUID())
      .send({
        stock_item_id: scopedStockItemId,
        quantity_delta: '1',
        reason: 'Commissary authorization test',
      });

    expect(assignedBalance.status).toBe(200);
    expect(assignedBalance.body.available_categories).toEqual(
      expect.arrayContaining([expect.any(String)]),
    );
    expect(assignedMovements.status).toBe(200);
    expect(branchAdjustment.status).toBe(201);
    expect(otherBranchBalance.status).toBe(403);
    expect(otherBranchAdjustment.status).toBe(403);
    expect(commissaryBalance.status).toBe(403);
    expect(commissaryMovements.status).toBe(403);
    expect(commissaryAdjustment.status).toBe(403);
  });

  it('authorizes commissary inventory with the dedicated permissions', async () => {
    authorizedUserId = commissaryManagerUserId;
    const client = request(accessApp.getHttpServer());
    const balance = await client.get('/inventory/commissary');
    const movements = await client.get('/inventory/commissary/movements');
    const adjustment = await client
      .post('/inventory/commissary/adjustments')
      .set('Idempotency-Key', randomUUID())
      .send({
        stock_item_id: scopedStockItemId,
        quantity_delta: '1',
        reason: 'Scoped commissary authorization test',
      });
    const branchBalance = await client.get(`/inventory/branches/${branchId}`);

    expect(balance.status).toBe(200);
    expect(balance.body.available_categories).toEqual(
      expect.arrayContaining([expect.any(String)]),
    );
    expect(movements.status).toBe(200);
    expect(adjustment.status).toBe(201);
    expect(branchBalance.status).toBe(403);
  });

  it('keeps the protected Super Admin inventory bypass', async () => {
    authorizedUserId = superAdminUserId;
    const client = request(accessApp.getHttpServer());

    expect((await client.get('/inventory/commissary')).status).toBe(200);
    expect(
      (await client.get(`/inventory/branches/${otherBranchId}`)).status,
    ).toBe(200);
  });

  it('filters both inventory scopes and returns unfiltered distinct categories', async () => {
    const activeBakingId = await createStockItem(
      `Filter flour ${suffix}`,
      'Baking',
      true,
    );
    const inactiveBakingId = await createStockItem(
      `Filter rice ${suffix}`,
      'Baking',
      false,
    );
    const activePantryId = await createStockItem(
      `Filter oil ${suffix}`,
      'Pantry',
      true,
    );
    stockItemIds.push(activeBakingId, inactiveBakingId, activePantryId);

    for (const path of [
      '/inventory/commissary',
      `/inventory/branches/${branchId}`,
    ]) {
      const byCategorySearch = await request(app.getHttpServer())
        .get(path)
        .query({ search: 'Baking', page_size: 100 });
      expect(byCategorySearch.status).toBe(200);
      expect(
        byCategorySearch.body.items.map((item: { id: string }) => item.id),
      ).toEqual(expect.arrayContaining([activeBakingId, inactiveBakingId]));

      const inactiveZeroBalance = await request(app.getHttpServer())
        .get(path)
        .query({ is_active: 'false', category: 'Baking', page_size: 100 });
      expect(inactiveZeroBalance.status).toBe(200);
      expect(inactiveZeroBalance.body.total).toBe(1);
      expect(inactiveZeroBalance.body.items[0]).toMatchObject({
        id: inactiveBakingId,
        is_active: false,
        quantity_on_hand: '0',
      });

      const filtered = await request(app.getHttpServer()).get(path).query({
        search: 'Filter',
        is_active: 'true',
        category: 'Baking',
        page: 1,
        page_size: 1,
      });
      expect(filtered.status).toBe(200);
      expect(filtered.body).toMatchObject({ total: 1, page: 1, page_size: 1 });
      expect(
        filtered.body.items.map((item: { id: string }) => item.id),
      ).toEqual([activeBakingId]);
      expect(filtered.body.items[0].quantity_on_hand).toBe('0');
      expect(filtered.body.available_categories).toContain('Baking');
      expect(filtered.body.available_categories).toContain('Pantry');
      expect(new Set(filtered.body.available_categories).size).toBe(
        filtered.body.available_categories.length,
      );
    }
  });

  it('validates inventory status and category query filters', async () => {
    const client = request(app.getHttpServer());
    const invalidStatus = await client
      .get('/inventory/commissary')
      .query({ is_active: 'yes' });
    const longCategory = await client
      .get('/inventory/commissary')
      .query({ category: 'x'.repeat(81) });

    expect(invalidStatus.status).toBe(400);
    expect(longCategory.status).toBe(400);
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

  async function createStockItem(
    name: string,
    category = 'Test',
    is_active = true,
  ): Promise<string> {
    const stockItem = await db
      .insertInto('stock_items')
      .values({ stock_item_name: name, category, unit: 'kg', is_active })
      .returning('id')
      .executeTakeFirstOrThrow();
    return stockItem.id;
  }

  async function createUser(roleId: string, label: string): Promise<string> {
    const user = await db
      .insertInto('coms_auth.users')
      .values({
        email: `inventory-${label}-${suffix}@example.invalid`,
        full_name: `Inventory ${label} ${suffix}`,
        contact_number: `INV${suffix.slice(0, 12)}${label.slice(0, 1)}`,
        hashed_password: 'not-used-by-test-auth-guard',
        role_id: roleId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return user.id;
  }
});
