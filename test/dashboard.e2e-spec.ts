import '../src/config/load-env';
import { ExecutionContext, INestApplication, ValidationPipe } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { sql, type Kysely } from 'kysely';
import request from 'supertest';
import type { App } from 'supertest/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthGatewayGuard } from '../src/common/guards/auth-gateway.guard';
import { AuthGuard } from '../src/common/guards/auth.guard';
import { AppModule } from '../src/app.module';
import { DATABASE } from '../src/database/database.module';
import type { DB } from '../src/database/db';

type TestRequest = { user?: { id: string } };

describe('dashboard routes (e2e)', () => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase();
  const branchIds: string[] = [];
  const userIds: string[] = [];
  const saleIds: string[] = [];
  const reportIds: string[] = [];
  const roleIds: string[] = [];
  let app: INestApplication<App>;
  let db: Kysely<DB>;
  let activeUserId: string;
  let branchManagerId: string;
  let cashierId: string;
  let customUserId: string;
  let superAdminId: string;
  let customRoleId: string;
  let assignedBranchId: string;
  let otherBranchId: string;
  let productId: string;
  let stockItemId: string;
  let dispatchId: string;

  async function createBranch(name: string) {
    const branch = await db
      .insertInto('branches')
      .values({ code: `DASH-${randomUUID().slice(0, 10)}`, branch_name: name })
      .returning('id')
      .executeTakeFirstOrThrow();
    branchIds.push(branch.id);
    return branch.id;
  }

  async function createUser(roleId: string, label: string) {
    const user = await db
      .insertInto('auth.users')
      .values({
        email: `dashboard-${label}-${randomUUID()}@example.com`,
        full_name: `Dashboard ${label}`,
        contact_number: `DASH-${randomUUID().slice(0, 12)}`,
        hashed_password: 'test-only-hash',
        role_id: roleId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    userIds.push(user.id);
    return user.id;
  }

  async function insertSale(
    status: 'COMPLETED' | 'VOIDED',
    amount: string,
    quantity: string,
  ) {
    const sale = await db
      .insertInto('sales')
      .values({
        branch_id: assignedBranchId,
        cashier_user_id: branchManagerId,
        status,
        tender_method: 'cash',
        total_amount: amount,
        idempotency_key: randomUUID(),
        created_at: new Date('2026-09-28T03:00:00.000Z'),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    saleIds.push(sale.id);
    const saleItem = await db
      .insertInto('sale_items')
      .values({
        sale_id: sale.id,
        product_id: productId,
        product_name_snapshot: 'Dashboard test product',
        quantity,
        unit_price: (Number(amount) / Number(quantity)).toFixed(2),
        line_total: amount,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('sale_events')
      .values({
        sale_id: sale.id,
        event_type: 'COMPLETED',
        actor_user_id: branchManagerId,
        created_at: new Date('2026-09-28T03:00:00.000Z'),
      })
      .execute();
    if (status === 'VOIDED')
      await db
        .insertInto('sale_events')
        .values({
          sale_id: sale.id,
          event_type: 'VOIDED',
          actor_user_id: branchManagerId,
          reason: 'Test void',
          idempotency_key: randomUUID(),
          created_at: new Date('2026-09-28T04:00:00.000Z'),
        })
        .execute();
    return { saleId: sale.id, saleItemId: saleItem.id };
  }

  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideGuard(AuthGatewayGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(AuthGuard)
      .useValue({
        canActivate: (execution: ExecutionContext) => {
          execution.switchToHttp().getRequest<TestRequest>().user = {
            id: activeUserId,
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

    const [branchManagerRole, cashierRole, superAdminRole] = await Promise.all([
      db
        .selectFrom('auth.roles')
        .select('id')
        .where('code', '=', 'BRANCH_MANAGER')
        .executeTakeFirstOrThrow(),
      db
        .selectFrom('auth.roles')
        .select('id')
        .where('code', '=', 'CASHIER')
        .executeTakeFirstOrThrow(),
      db
        .selectFrom('auth.roles')
        .select('id')
        .where('code', '=', 'SUPER_ADMIN')
        .executeTakeFirstOrThrow(),
    ]);
    const customRole = await db
      .insertInto('auth.roles')
      .values({
        code: `DASHBOARD_TEST_${suffix}`,
        role_name: `Dashboard Test ${suffix}`,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    customRoleId = customRole.id;
    roleIds.push(customRole.id);

    assignedBranchId = await createBranch(`Dashboard Assigned ${suffix}`);
    otherBranchId = await createBranch(`Dashboard Other ${suffix}`);
    branchManagerId = await createUser(branchManagerRole.id, 'branch-manager');
    cashierId = await createUser(cashierRole.id, 'cashier');
    customUserId = await createUser(customRole.id, 'custom');
    superAdminId = await createUser(superAdminRole.id, 'super-admin');
    activeUserId = branchManagerId;
    await db
      .insertInto('auth.branch_users')
      .values([
        { user_id: branchManagerId, branch_id: assignedBranchId },
        { user_id: cashierId, branch_id: assignedBranchId },
      ])
      .execute();

    const product = await db
      .insertInto('products')
      .values({ product_name: `Dashboard Product ${suffix}` })
      .returning('id')
      .executeTakeFirstOrThrow();
    productId = product.id;
    await insertSale('COMPLETED', '75.00', '1.5');
    await insertSale('VOIDED', '25.00', '2');

    const submitted = await db
      .insertInto('daily_branch_reports')
      .values({
        branch_id: assignedBranchId,
        business_date: '2026-09-27',
        status: 'SUBMITTED',
        idempotency_key: randomUUID(),
        created_by_user_id: branchManagerId,
        submitted_by_user_id: branchManagerId,
        submitted_at: new Date('2026-09-28T01:00:00.000Z'),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const approved = await db
      .insertInto('daily_branch_reports')
      .values({
        branch_id: assignedBranchId,
        business_date: '2026-09-28',
        status: 'APPROVED',
        idempotency_key: randomUUID(),
        created_by_user_id: branchManagerId,
        submitted_by_user_id: branchManagerId,
        submitted_at: new Date('2026-09-28T02:00:00.000Z'),
        reviewed_by_user_id: branchManagerId,
        reviewed_at: new Date('2026-09-28T05:00:00.000Z'),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    reportIds.push(submitted.id, approved.id);

    const stockItem = await db
      .insertInto('stock_items')
      .values({
        stock_item_name: `Dashboard Stock ${suffix}`,
        category: 'Test',
        unit: 'kg',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    stockItemId = stockItem.id;
    const dispatch = await db
      .insertInto('dispatches')
      .values({
        stock_request_id: null,
        branch_id: assignedBranchId,
        status: 'PARTIALLY_RECEIVED',
        idempotency_key: randomUUID(),
        created_by_user_id: branchManagerId,
        dispatched_by_user_id: branchManagerId,
        dispatched_at: new Date('2026-09-28T01:00:00.000Z'),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    dispatchId = dispatch.id;
    await db
      .insertInto('dispatch_items')
      .values({
        dispatch_id: dispatch.id,
        stock_item_id: stockItem.id,
        stock_request_item_id: null,
        quantity_dispatched: '10',
      })
      .execute();
    const discrepancy = await sql<{ id: string }>`
      INSERT INTO dispatch_discrepancies
        (dispatch_id, status, reported_by_user_id, idempotency_key)
      VALUES (${dispatch.id}, 'OPEN', ${branchManagerId}, ${randomUUID()})
      RETURNING id
    `.execute(db);
    await sql`
      INSERT INTO dispatch_discrepancy_events
        (discrepancy_id, event_type, actor_user_id, note, idempotency_key)
      VALUES
        (${discrepancy.rows[0]!.id}, 'REPORTED', ${branchManagerId},
         'Dashboard test discrepancy', ${randomUUID()})
    `.execute(db);
  }, 30000);

  afterAll(async () => {
    if (db) {
      if (dispatchId) {
        await sql`
          DELETE FROM dispatch_discrepancy_events
          WHERE discrepancy_id IN (
            SELECT id FROM dispatch_discrepancies WHERE dispatch_id = ${dispatchId}
          )
        `.execute(db);
        await sql`DELETE FROM dispatch_discrepancies WHERE dispatch_id = ${dispatchId}`.execute(
          db,
        );
        await db.deleteFrom('dispatch_items').where('dispatch_id', '=', dispatchId).execute();
        await db.deleteFrom('dispatches').where('id', '=', dispatchId).execute();
      }
      if (reportIds.length)
        await db.deleteFrom('daily_branch_reports').where('id', 'in', reportIds).execute();
      if (saleIds.length) {
        await db.deleteFrom('sale_events').where('sale_id', 'in', saleIds).execute();
        await db.deleteFrom('sale_items').where('sale_id', 'in', saleIds).execute();
        await db.deleteFrom('sales').where('id', 'in', saleIds).execute();
      }
      if (productId) await db.deleteFrom('products').where('id', '=', productId).execute();
      if (stockItemId) await db.deleteFrom('stock_items').where('id', '=', stockItemId).execute();
      if (branchIds.length)
        await db.deleteFrom('branches').where('id', 'in', branchIds).execute();
      if (userIds.length)
        await db.deleteFrom('auth.users').where('id', 'in', userIds).execute();
      if (roleIds.length)
        await db.deleteFrom('auth.roles').where('id', 'in', roleIds).execute();
    }
    await app?.close();
  });

  it('serves assigned-branch metrics, Manila trends, and branch comparisons', async () => {
    activeUserId = branchManagerId;
    const branchDashboard = await request(app.getHttpServer())
      .get(`/branches/${assignedBranchId}/dashboard?from=2026-09-22&to=2026-09-28`)
      .expect(200);
    expect(branchDashboard.body).toMatchObject({
      period: {
        from: '2026-09-22',
        to: '2026-09-28',
        time_zone: 'Asia/Manila',
      },
      summary: {
        completed_sales_amount: '100',
        completed_sales_count: 2,
        voided_sales_amount: '25',
        voided_sales_count: 1,
        units_sold: '3.5',
        submitted_reports_count: 1,
        approved_reports_count: 1,
        open_discrepancies_count: 1,
        in_transit_dispatches_count: 1,
      },
      branches: [{ branch_id: assignedBranchId }],
    });
    expect(branchDashboard.body.sales_trend).toHaveLength(7);
    expect(branchDashboard.body.sales_trend.at(-1)).toMatchObject({
      date: '2026-09-28',
      completed_sales_amount: '100',
      completed_sales_count: 2,
      voided_sales_amount: '25',
      voided_sales_count: 1,
      units_sold: '3.5',
    });

    const globalDenied = await request(app.getHttpServer())
      .get('/dashboard/overview?from=2026-09-22&to=2026-09-28')
      .expect(403);
    expect(globalDenied.body.message).toBe('Permission required');
    await request(app.getHttpServer())
      .get(`/branches/${otherBranchId}/dashboard?from=2026-09-22&to=2026-09-28`)
      .expect(403);

    const globalGrant = await db
      .selectFrom('auth.permissions')
      .select('id')
      .where('module_key', '=', 'dashboard')
      .where('action_key', '=', 'global_read')
      .executeTakeFirstOrThrow();
    const withoutGrant = await request(app.getHttpServer())
      .get('/dashboard/overview?from=2026-09-22&to=2026-09-28')
      .expect(403);
    expect(withoutGrant.body.message).toBe('Permission required');

    activeUserId = superAdminId;
    const superAdminOverview = await request(app.getHttpServer())
      .get('/dashboard/overview?from=2026-09-22&to=2026-09-28')
      .expect(200);
    expect(superAdminOverview.body.summary.completed_sales_amount).toBe('100');
    expect(superAdminOverview.body.branches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ branch_id: assignedBranchId }),
        expect.objectContaining({ branch_id: otherBranchId }),
      ]),
    );
    await request(app.getHttpServer())
      .get(`/branches/${otherBranchId}/dashboard?from=2026-09-22&to=2026-09-28`)
      .expect(200);

    activeUserId = cashierId;
    await request(app.getHttpServer())
      .get(`/branches/${assignedBranchId}/dashboard?from=2026-09-22&to=2026-09-28`)
      .expect(403);

    activeUserId = customUserId;
    await request(app.getHttpServer())
      .get('/dashboard/overview?from=2026-09-22&to=2026-09-28')
      .expect(403);
    await db
      .insertInto('auth.role_permissions')
      .values({ role_id: customRoleId, permission_id: globalGrant.id })
      .execute();
    const customGlobalOverview = await request(app.getHttpServer())
      .get('/dashboard/overview?from=2026-09-22&to=2026-09-28&branch_id=' + assignedBranchId)
      .expect(200);
    expect(customGlobalOverview.body.branches).toHaveLength(1);

    activeUserId = branchManagerId;
    const emptyPeriod = await request(app.getHttpServer())
      .get(`/branches/${assignedBranchId}/dashboard?from=2026-09-15&to=2026-09-21`)
      .expect(200);
    expect(emptyPeriod.body.summary).toMatchObject({
      completed_sales_amount: '0',
      completed_sales_count: 0,
      voided_sales_amount: '0',
      voided_sales_count: 0,
      submitted_reports_count: 0,
      approved_reports_count: 0,
    });
    expect(emptyPeriod.body.sales_trend.every((day: { units_sold: string }) => day.units_sold === '0')).toBe(true);
    await request(app.getHttpServer())
      .get(`/branches/${assignedBranchId}/dashboard?from=2026-09-21&to=2026-09-28`)
      .expect(400);
    await request(app.getHttpServer())
      .get(`/branches/${assignedBranchId}/dashboard?from=2026-09-31&to=2026-10-07`)
      .expect(400);
  });
});
