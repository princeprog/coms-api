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

function normalizeDecimal(value: string): string {
  const [whole, fraction = ''] = value.split('.');
  const normalizedFraction = fraction.replace(/0+$/, '');
  return normalizedFraction ? `${whole}.${normalizedFraction}` : whole;
}

function manilaDate(offsetDays = 0): string {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(
    parts.map(({ type, value }) => [type, value]),
  );
  const date = new Date(
    Date.UTC(
      Number(values.year),
      Number(values.month) - 1,
      Number(values.day) + offsetDays,
    ),
  );
  return date.toISOString().slice(0, 10);
}

describe('daily report routes (e2e)', () => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase();
  const roleIds: string[] = [];
  const userIds: string[] = [];
  const createdReports: string[] = [];
  const movementIds: string[] = [];
  const saleIds: string[] = [];
  const saleItemIds: string[] = [];
  let productId: string;
  let activeActorId: string;
  let reporterId: string;
  let reviewerId: string;
  let deniedUserId: string;
  let unassignedUserId: string;
  let branchId: string;
  let flowBranchId: string;
  let stockItemId: string;
  let untrackedStockItemId: string;
  let flowStockItemId: string;
  let flowSupplierId: string;
  let flowReceiptId: string;
  let flowRequestId: string;
  let flowDispatchId: string;
  let app: INestApplication<App>;
  let db: Kysely<DB>;

  async function createUser(roleId: string, purpose: string): Promise<string> {
    const user = await db
      .insertInto('auth.users')
      .values({
        email: `daily-report-${purpose}-${randomUUID()}@example.com`,
        full_name: `Daily Report ${purpose}`,
        contact_number: `DR-${randomUUID().slice(0, 12)}`,
        hashed_password: 'test-only-hash',
        role_id: roleId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    userIds.push(user.id);
    return user.id;
  }

  async function createRole(purpose: string): Promise<string> {
    const role = await db
      .insertInto('auth.roles')
      .values({
        code: `DR_${purpose}_${suffix}`,
        role_name: `Daily Reports ${purpose} ${suffix}`,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    roleIds.push(role.id);
    return role.id;
  }

  async function insertMovement(
    movementType: 'TRANSFER_IN' | 'ADJUSTMENT',
    quantityDelta: string,
    createdAt: string,
    reason?: string,
  ) {
    const movement = await db
      .insertInto('inventory_movements')
      .values({
        inventory_scope: 'BRANCH',
        branch_id: branchId,
        stock_item_id: stockItemId,
        movement_type: movementType,
        quantity_delta: quantityDelta,
        reason: reason ?? null,
        actor_user_id: reporterId,
        created_at: new Date(createdAt),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    movementIds.push(movement.id);
  }

  async function createReport(
    businessDate: string,
    idempotencyKey = randomUUID(),
  ) {
    const response = await request(app.getHttpServer())
      .post(`/branches/${branchId}/daily-reports`)
      .set('Idempotency-Key', idempotencyKey)
      .send({ business_date: businessDate })
      .expect(201);
    createdReports.push(response.body.id as string);
    return { report: response.body, idempotencyKey };
  }

  function reportUrl(reportId: string) {
    return `/branches/${branchId}/daily-reports/${reportId}`;
  }

  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideGuard(AuthGatewayGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(AuthGuard)
      .useValue({
        canActivate: (execution: ExecutionContext) => {
          execution.switchToHttp().getRequest<TestRequest>().user = {
            id: activeActorId,
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

    const reportRoleId = await createRole('REPORTER');
    const deniedRoleId = await createRole('DENIED');
    const workflowPermissionKeys = new Set([
      'daily_reports.read',
      'daily_reports.create',
      'daily_reports.update',
      'daily_reports.submit',
      'daily_reports.return',
      'daily_reports.approve',
      'supplier_receipts.read',
      'supplier_receipts.create',
      'supplier_receipts.post',
      'stock_requests.read',
      'stock_requests.create',
      'stock_requests.approve',
      'dispatches.read',
      'dispatches.create',
      'dispatches.dispatch',
      'dispatches.receive',
    ]);
    const permissions = await db
      .selectFrom('auth.permissions')
      .select(['id', 'module_key', 'action_key'])
      .where('module_key', 'in', [
        'daily_reports',
        'supplier_receipts',
        'stock_requests',
        'dispatches',
      ])
      .execute();
    const workflowPermissions = permissions.filter(
      ({ module_key, action_key }) =>
        workflowPermissionKeys.has(`${module_key}.${action_key}`),
    );
    await db
      .insertInto('auth.role_permissions')
      .values(
        workflowPermissions.map(({ id }) => ({
          role_id: reportRoleId,
          permission_id: id,
        })),
      )
      .execute();

    reporterId = await createUser(reportRoleId, 'Reporter');
    reviewerId = await createUser(reportRoleId, 'Reviewer');
    deniedUserId = await createUser(deniedRoleId, 'Denied');
    unassignedUserId = await createUser(reportRoleId, 'Unassigned');
    activeActorId = reporterId;

    const branch = await db
      .insertInto('branches')
      .values({
        code: `DR-${suffix}`,
        branch_name: `Daily Report Branch ${suffix}`,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    branchId = branch.id;
    await db
      .insertInto('auth.branch_users')
      .values([
        { user_id: reporterId, branch_id: branchId },
        { user_id: reviewerId, branch_id: branchId },
        { user_id: deniedUserId, branch_id: branchId },
      ])
      .execute();

    const flowBranch = await db
      .insertInto('branches')
      .values({
        code: `DF-${suffix}`,
        branch_name: `Daily Flow Branch ${suffix}`,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    flowBranchId = flowBranch.id;
    await db
      .insertInto('auth.branch_users')
      .values([
        { user_id: reporterId, branch_id: flowBranchId },
        { user_id: reviewerId, branch_id: flowBranchId },
      ])
      .execute();

    const flowStockItem = await db
      .insertInto('stock_items')
      .values({
        stock_item_name: `Daily Flow Test Flour ${suffix}`,
        category: 'Daily Report Test',
        unit: 'kg',
        created_at: new Date('2000-01-01T00:00:00.000Z'),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    flowStockItemId = flowStockItem.id;
    const flowSupplier = await db
      .insertInto('suppliers')
      .values({ supplier_name: `Daily Flow Test Supplier ${suffix}` })
      .returning('id')
      .executeTakeFirstOrThrow();
    flowSupplierId = flowSupplier.id;

    const stockItem = await db
      .insertInto('stock_items')
      .values({
        stock_item_name: `Daily Report Test Flour ${suffix}`,
        category: 'Daily Report Test',
        unit: 'kg',
        created_at: new Date('2026-09-20T00:00:00.000Z'),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    stockItemId = stockItem.id;
    const untrackedStockItem = await db
      .insertInto('stock_items')
      .values({
        stock_item_name: `Daily Report Untracked Flour ${suffix}`,
        category: 'Daily Report Test',
        unit: 'kg',
        created_at: new Date('2026-09-20T00:00:00.000Z'),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    untrackedStockItemId = untrackedStockItem.id;

    const product = await db
      .insertInto('products')
      .values({ product_name: `Daily Report Test Product ${suffix}` })
      .returning('id')
      .executeTakeFirstOrThrow();
    productId = product.id;

    const sale = await db
      .insertInto('sales')
      .values({
        branch_id: branchId,
        cashier_user_id: reporterId,
        status: 'VOIDED',
        tender_method: 'cash',
        total_amount: '2.0000',
        idempotency_key: randomUUID(),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    saleIds.push(sale.id);
    const saleItem = await db
      .insertInto('sale_items')
      .values({
        sale_id: sale.id,
        product_id: productId,
        product_name_snapshot: `Daily Report Test Product ${suffix}`,
        quantity: '1.0000',
        unit_price: '2.0000',
        line_total: '2.0000',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    saleItemIds.push(saleItem.id);
    const saleConsumption = await db
      .insertInto('sale_item_consumptions')
      .values({
        sale_item_id: saleItem.id,
        stock_item_id: stockItemId,
        quantity_consumed: '2.0000',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('sale_events')
      .values({
        sale_id: sale.id,
        event_type: 'COMPLETED',
        actor_user_id: reporterId,
      })
      .execute();
    const saleMovement = await db
      .insertInto('inventory_movements')
      .values({
        inventory_scope: 'BRANCH',
        branch_id: branchId,
        stock_item_id: stockItemId,
        movement_type: 'SALE',
        quantity_delta: '-2.0000',
        actor_user_id: reporterId,
        sale_item_consumption_id: saleConsumption.id,
        created_at: new Date('2026-09-23T06:00:00.000Z'),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    movementIds.push(saleMovement.id);
    await db
      .insertInto('sale_events')
      .values({
        sale_id: sale.id,
        event_type: 'VOIDED',
        actor_user_id: reporterId,
        reason: 'Voided earlier sale',
        idempotency_key: randomUUID(),
      })
      .execute();
    const saleVoidMovement = await db
      .insertInto('inventory_movements')
      .values({
        inventory_scope: 'BRANCH',
        branch_id: branchId,
        stock_item_id: stockItemId,
        movement_type: 'SALE_VOID',
        quantity_delta: '1.0000',
        reason: 'Voided earlier sale',
        actor_user_id: reporterId,
        reversal_of_movement_id: saleMovement.id,
        created_at: new Date('2026-09-23T06:10:00.000Z'),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    movementIds.push(saleVoidMovement.id);

    const laterSale = await db
      .insertInto('sales')
      .values({
        branch_id: branchId,
        cashier_user_id: reporterId,
        status: 'COMPLETED',
        tender_method: 'cash',
        total_amount: '15.0000',
        idempotency_key: randomUUID(),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    saleIds.push(laterSale.id);
    const laterSaleItem = await db
      .insertInto('sale_items')
      .values({
        sale_id: laterSale.id,
        product_id: productId,
        product_name_snapshot: `Daily Report Test Product ${suffix}`,
        quantity: '1.0000',
        unit_price: '15.0000',
        line_total: '15.0000',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    saleItemIds.push(laterSaleItem.id);
    const laterConsumption = await db
      .insertInto('sale_item_consumptions')
      .values({
        sale_item_id: laterSaleItem.id,
        stock_item_id: stockItemId,
        quantity_consumed: '15.0000',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('sale_events')
      .values({
        sale_id: laterSale.id,
        event_type: 'COMPLETED',
        actor_user_id: reporterId,
      })
      .execute();
    const laterSaleMovement = await db
      .insertInto('inventory_movements')
      .values({
        inventory_scope: 'BRANCH',
        branch_id: branchId,
        stock_item_id: stockItemId,
        movement_type: 'SALE',
        quantity_delta: '-15.0000',
        actor_user_id: reporterId,
        sale_item_consumption_id: laterConsumption.id,
        created_at: new Date('2026-09-23T20:00:00.000Z'),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    movementIds.push(laterSaleMovement.id);

    await insertMovement('TRANSFER_IN', '10.0000', '2026-09-22T15:59:59.999Z');
    await insertMovement('TRANSFER_IN', '5.0000', '2026-09-22T16:00:00.000Z');
    await insertMovement(
      'ADJUSTMENT',
      '-0.5000',
      '2026-09-23T07:00:00.000Z',
      'Recorded count adjustment',
    );
    await insertMovement('TRANSFER_IN', '3.0000', '2026-09-23T16:00:00.000Z');
    await insertMovement('TRANSFER_IN', '4.0000', '2026-09-23T17:00:00.000Z');
    await db
      .insertInto('branch_inventory')
      .values({
        branch_id: branchId,
        stock_item_id: stockItemId,
        quantity_on_hand: '5.5000',
      })
      .execute();
  }, 30000);

  afterAll(async () => {
    if (db) {
      if (flowStockItemId) {
        await db
          .deleteFrom('inventory_movements')
          .where('stock_item_id', '=', flowStockItemId)
          .execute();
      }
      if (createdReports.length) {
        await db
          .deleteFrom('inventory_movements')
          .where('daily_branch_report_item_id', 'in', (query) =>
            query
              .selectFrom('daily_branch_report_items')
              .select('id')
              .where('daily_branch_report_id', 'in', createdReports),
          )
          .execute();
        await db
          .deleteFrom('daily_branch_report_events')
          .where('daily_branch_report_id', 'in', createdReports)
          .execute();
        await db
          .deleteFrom('daily_branch_report_items')
          .where('daily_branch_report_id', 'in', createdReports)
          .execute();
        await db
          .deleteFrom('daily_branch_reports')
          .where('id', 'in', createdReports)
          .execute();
      }
      if (flowDispatchId) {
        await db
          .deleteFrom('dispatch_events')
          .where('dispatch_id', '=', flowDispatchId)
          .execute();
        const receiptIds = db
          .selectFrom('dispatch_receipts')
          .select('id')
          .where('dispatch_id', '=', flowDispatchId);
        await db
          .deleteFrom('dispatch_receipt_items')
          .where('dispatch_receipt_id', 'in', receiptIds)
          .execute();
        await db
          .deleteFrom('dispatch_receipts')
          .where('dispatch_id', '=', flowDispatchId)
          .execute();
        await db
          .deleteFrom('dispatch_items')
          .where('dispatch_id', '=', flowDispatchId)
          .execute();
        await db
          .deleteFrom('dispatches')
          .where('id', '=', flowDispatchId)
          .execute();
      }
      if (flowRequestId) {
        await db
          .deleteFrom('stock_request_events')
          .where('stock_request_id', '=', flowRequestId)
          .execute();
        await db
          .deleteFrom('stock_request_items')
          .where('stock_request_id', '=', flowRequestId)
          .execute();
        await db
          .deleteFrom('stock_requests')
          .where('id', '=', flowRequestId)
          .execute();
      }
      if (flowReceiptId) {
        await db
          .deleteFrom('supplier_receipt_items')
          .where('supplier_receipt_id', '=', flowReceiptId)
          .execute();
        await db
          .deleteFrom('supplier_receipts')
          .where('id', '=', flowReceiptId)
          .execute();
      }
      if (movementIds.length)
        await db
          .deleteFrom('inventory_movements')
          .where('id', 'in', movementIds)
          .execute();
      if (saleIds.length) {
        await db
          .deleteFrom('sale_events')
          .where('sale_id', 'in', saleIds)
          .execute();
        await db
          .deleteFrom('sale_item_consumptions')
          .where('sale_item_id', 'in', saleItemIds)
          .execute();
        await db
          .deleteFrom('sale_items')
          .where('id', 'in', saleItemIds)
          .execute();
        await db.deleteFrom('sales').where('id', 'in', saleIds).execute();
      }
      if (branchId) {
        await db
          .deleteFrom('branch_inventory')
          .where('branch_id', '=', branchId)
          .execute();
        await db
          .deleteFrom('auth.branch_users')
          .where('branch_id', '=', branchId)
          .execute();
        await db.deleteFrom('branches').where('id', '=', branchId).execute();
      }
      if (flowBranchId) {
        await db
          .deleteFrom('branch_inventory')
          .where('branch_id', '=', flowBranchId)
          .execute();
        await db
          .deleteFrom('auth.branch_users')
          .where('branch_id', '=', flowBranchId)
          .execute();
        await db
          .deleteFrom('branches')
          .where('id', '=', flowBranchId)
          .execute();
      }
      if (stockItemId)
        await db
          .deleteFrom('stock_items')
          .where('id', '=', stockItemId)
          .execute();
      if (untrackedStockItemId)
        await db
          .deleteFrom('stock_items')
          .where('id', '=', untrackedStockItemId)
          .execute();
      if (flowStockItemId) {
        await db
          .deleteFrom('commissary_inventory')
          .where('stock_item_id', '=', flowStockItemId)
          .execute();
        await db
          .deleteFrom('stock_items')
          .where('id', '=', flowStockItemId)
          .execute();
      }
      if (flowSupplierId)
        await db
          .deleteFrom('suppliers')
          .where('id', '=', flowSupplierId)
          .execute();
      if (productId)
        await db.deleteFrom('products').where('id', '=', productId).execute();
      if (roleIds.length)
        await db
          .deleteFrom('auth.role_permissions')
          .where('role_id', 'in', roleIds)
          .execute();
      if (userIds.length)
        await db.deleteFrom('auth.users').where('id', 'in', userIds).execute();
      if (roleIds.length)
        await db.deleteFrom('auth.roles').where('id', 'in', roleIds).execute();
    }
    if (app) await app.close();
  });

  it('derives a Manila-day report and approves one net stock reconciliation', async () => {
    const { report: created, idempotencyKey } =
      await createReport('2026-09-23');
    expect(created).toMatchObject({
      branch_id: branchId,
      business_date: '2026-09-23',
      status: 'DRAFT',
    });
    expect(
      created.items.some(
        (row: { stock_item_id: string }) =>
          row.stock_item_id === untrackedStockItemId,
      ),
    ).toBe(false);
    const item = created.items.find(
      (candidate: { stock_item_id: string }) =>
        candidate.stock_item_id === stockItemId,
    );
    expect(item).toBeDefined();
    expect(
      Object.fromEntries(
        [
          'opening_quantity',
          'receipt_quantity',
          'sale_consumption_quantity',
          'sale_void_reversal_quantity',
          'ledger_adjustment_quantity',
          'ledger_closing_quantity',
          'expected_closing_quantity',
        ].map((key) => [key, normalizeDecimal(item[key] as string)]),
      ),
    ).toEqual({
      opening_quantity: '10',
      receipt_quantity: '5',
      sale_consumption_quantity: '2',
      sale_void_reversal_quantity: '1',
      ledger_adjustment_quantity: '-0.5',
      ledger_closing_quantity: '13.5',
      expected_closing_quantity: '13.5',
    });

    const replay = await createReport('2026-09-23', idempotencyKey);
    expect(replay.report.id).toBe(created.id);
    await request(app.getHttpServer())
      .post(`/branches/${branchId}/daily-reports`)
      .set('Idempotency-Key', idempotencyKey)
      .send({ business_date: '2026-09-22' })
      .expect(409);
    await request(app.getHttpServer())
      .post(`/branches/${branchId}/daily-reports`)
      .set('Idempotency-Key', randomUUID())
      .send({ business_date: '2026-09-23' })
      .expect(409);
    await request(app.getHttpServer())
      .get(`/branches/${branchId}/daily-reports?page=1&page_size=10`)
      .expect(200)
      .expect(({ body }) => {
        expect(body.items.map((row: { id: string }) => row.id)).toContain(
          created.id,
        );
      });
    await request(app.getHttpServer())
      .put(reportUrl(created.id))
      .send({
        items: created.items.map(
          (row: { stock_item_id: string; [key: string]: unknown }) => ({
            stock_item_id: row.stock_item_id,
            physical_closing_quantity:
              row.stock_item_id === stockItemId ? '12.7500' : '0',
            waste_quantity: row.stock_item_id === stockItemId ? '0.5000' : '0',
            waste_reason:
              row.stock_item_id === stockItemId
                ? 'Spoiled during service'
                : undefined,
            adjustment_quantity:
              row.stock_item_id === stockItemId ? '0.2500' : '0',
            adjustment_reason:
              row.stock_item_id === stockItemId
                ? 'Approved count correction'
                : undefined,
          }),
        ),
      })
      .expect(200)
      .expect(({ body }) => {
        const saved = body.items.find(
          (row: { stock_item_id: string }) => row.stock_item_id === stockItemId,
        );
        expect(normalizeDecimal(saved.expected_closing_quantity)).toBe('13.25');
        expect(normalizeDecimal(saved.variance_quantity)).toBe('-0.5');
      });

    await request(app.getHttpServer())
      .put(reportUrl(created.id))
      .send({
        items: [
          {
            stock_item_id: stockItemId,
            physical_closing_quantity: '12',
            waste_quantity: '0',
            adjustment_quantity: '0',
            expected_closing_quantity: '12',
          },
        ],
      })
      .expect(400);

    await request(app.getHttpServer())
      .post(`${reportUrl(created.id)}/submit`)
      .expect(200)
      .expect(({ body }) => expect(body.status).toBe('SUBMITTED'));

    activeActorId = reviewerId;
    await request(app.getHttpServer())
      .post(`${reportUrl(created.id)}/return`)
      .send({ reason: 'Please recount the flour.' })
      .expect(200)
      .expect(({ body }) => expect(body.status).toBe('RETURNED'));

    activeActorId = reporterId;
    const returned = await request(app.getHttpServer())
      .get(reportUrl(created.id))
      .expect(200);
    await request(app.getHttpServer())
      .put(reportUrl(created.id))
      .send({
        items: returned.body.items.map((row: { stock_item_id: string }) => ({
          stock_item_id: row.stock_item_id,
          physical_closing_quantity:
            row.stock_item_id === stockItemId ? '12.5000' : '0',
          waste_quantity: row.stock_item_id === stockItemId ? '0.5000' : '0',
          waste_reason:
            row.stock_item_id === stockItemId
              ? 'Spoiled during service'
              : undefined,
          adjustment_quantity:
            row.stock_item_id === stockItemId ? '0.2500' : '0',
          adjustment_reason:
            row.stock_item_id === stockItemId
              ? 'Approved count correction'
              : undefined,
        })),
      })
      .expect(200);
    await request(app.getHttpServer())
      .post(`${reportUrl(created.id)}/submit`)
      .expect(200)
      .expect(({ body }) => expect(body.status).toBe('SUBMITTED'));

    activeActorId = reviewerId;
    const approvalResponses = await Promise.all([
      request(app.getHttpServer())
        .post(`${reportUrl(created.id)}/approve`)
        .expect(200),
      request(app.getHttpServer())
        .post(`${reportUrl(created.id)}/approve`)
        .expect(200),
    ]);
    const approved = approvalResponses[0]!;
    expect(approvalResponses[1]!.body.status).toBe('APPROVED');
    expect(approved.body.status).toBe('APPROVED');
    const approvedItem = approved.body.items.find(
      (row: { stock_item_id: string }) => row.stock_item_id === stockItemId,
    );
    expect(normalizeDecimal(approvedItem.expected_closing_quantity)).toBe(
      '13.25',
    );
    expect(normalizeDecimal(approvedItem.variance_quantity)).toBe('-0.75');

    const balance = await db
      .selectFrom('branch_inventory')
      .select('quantity_on_hand')
      .where('branch_id', '=', branchId)
      .where('stock_item_id', '=', stockItemId)
      .executeTakeFirstOrThrow();
    expect(normalizeDecimal(balance.quantity_on_hand)).toBe('4.5');
    const reconciliation = await db
      .selectFrom('inventory_movements')
      .select([
        'movement_type',
        'quantity_delta',
        'daily_branch_report_item_id',
      ])
      .where('daily_branch_report_item_id', '=', approvedItem.id)
      .execute();
    expect(reconciliation).toHaveLength(1);
    expect(reconciliation[0]?.movement_type).toBe('REPORT_ADJUSTMENT');
    expect(normalizeDecimal(reconciliation[0]!.quantity_delta)).toBe('-1');

    expect(
      await db
        .selectFrom('inventory_movements')
        .select((expression) => expression.fn.countAll().as('count'))
        .where('daily_branch_report_item_id', '=', approvedItem.id)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({ count: '1' });

    activeActorId = reporterId;
    const nextDay = await createReport('2026-09-24');
    const nextDayItem = nextDay.report.items.find(
      (row: { stock_item_id: string }) => row.stock_item_id === stockItemId,
    );
    expect({
      opening: normalizeDecimal(nextDayItem.opening_quantity),
      receipts: normalizeDecimal(nextDayItem.receipt_quantity),
      sales: normalizeDecimal(nextDayItem.sale_consumption_quantity),
      ledgerClosing: normalizeDecimal(nextDayItem.ledger_closing_quantity),
    }).toEqual({
      opening: '12.5',
      receipts: '7',
      sales: '15',
      ledgerClosing: '4.5',
    });

    const earlier = await createReport('2026-09-22');
    const earlierItem = earlier.report.items.find(
      (row: { stock_item_id: string }) => row.stock_item_id === stockItemId,
    );
    expect(normalizeDecimal(earlierItem.ledger_closing_quantity)).toBe('10');
    await request(app.getHttpServer())
      .put(reportUrl(earlier.report.id))
      .send({
        items: earlier.report.items.map((row: { stock_item_id: string }) => ({
          stock_item_id: row.stock_item_id,
          physical_closing_quantity: '0',
          waste_quantity: '0',
          adjustment_quantity: '0',
        })),
      })
      .expect(200);
    await request(app.getHttpServer())
      .post(`${reportUrl(earlier.report.id)}/submit`)
      .expect(200);
    activeActorId = reviewerId;
    await request(app.getHttpServer())
      .post(`${reportUrl(earlier.report.id)}/approve`)
      .expect(409);
    await request(app.getHttpServer())
      .get(reportUrl(earlier.report.id))
      .expect(200)
      .expect(({ body }) => expect(body.status).toBe('SUBMITTED'));
    const unchangedBalance = await db
      .selectFrom('branch_inventory')
      .select('quantity_on_hand')
      .where('branch_id', '=', branchId)
      .where('stock_item_id', '=', stockItemId)
      .executeTakeFirstOrThrow();
    expect(normalizeDecimal(unchangedBalance.quantity_on_hand)).toBe('4.5');
    expect(
      await db
        .selectFrom('inventory_movements')
        .select((expression) => expression.fn.countAll().as('count'))
        .where('daily_branch_report_item_id', '=', earlierItem.id)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({ count: '0' });
  });

  it('requires grants, branch assignment, complete physical counts, and valid report dates', async () => {
    activeActorId = deniedUserId;
    await request(app.getHttpServer())
      .get(`/branches/${branchId}/daily-reports`)
      .expect(403);

    activeActorId = unassignedUserId;
    await request(app.getHttpServer())
      .get(`/branches/${branchId}/daily-reports`)
      .expect(403);

    activeActorId = reporterId;
    await request(app.getHttpServer())
      .post(`/branches/${branchId}/daily-reports`)
      .set('Idempotency-Key', randomUUID())
      .send({ business_date: '2026-09-31' })
      .expect(400);
    await request(app.getHttpServer())
      .post(`/branches/${branchId}/daily-reports`)
      .set('Idempotency-Key', randomUUID())
      .send({ business_date: '2999-01-01' })
      .expect(400);

    const { report } = await createReport('2026-09-21');
    await request(app.getHttpServer())
      .post(`${reportUrl(report.id)}/submit`)
      .expect(409);
  });

  it('takes a supplier receipt through branch replenishment and daily report approval', async () => {
    const businessDate = manilaDate(-1);
    const supplierReceipt = await request(app.getHttpServer())
      .post('/supplier-receipts')
      .set('Idempotency-Key', randomUUID())
      .send({
        supplier_id: flowSupplierId,
        received_at: businessDate,
        items: [
          {
            stock_item_id: flowStockItemId,
            quantity_received: '12',
            unit_cost: '10.25',
          },
        ],
      })
      .expect(201);
    flowReceiptId = supplierReceipt.body.id as string;
    expect(supplierReceipt.body.status).toBe('DRAFT');

    const postedSupplierReceipt = await request(app.getHttpServer())
      .post(`/supplier-receipts/${flowReceiptId}/post`)
      .expect(201);
    expect(postedSupplierReceipt.body.status).toBe('POSTED');

    const requestResponse = await request(app.getHttpServer())
      .post('/stock-requests')
      .set('Idempotency-Key', randomUUID())
      .send({
        branch_id: flowBranchId,
        items: [{ stock_item_id: flowStockItemId, quantity_requested: '8' }],
      })
      .expect(201);
    flowRequestId = requestResponse.body.id as string;
    expect(requestResponse.body.status).toBe('PENDING');

    activeActorId = reviewerId;
    const approvedRequest = await request(app.getHttpServer())
      .post(`/stock-requests/${flowRequestId}/approve`)
      .expect(201);
    expect(approvedRequest.body.status).toBe('APPROVED');

    activeActorId = reporterId;
    const dispatchDraft = await request(app.getHttpServer())
      .post('/dispatches')
      .set('Idempotency-Key', randomUUID())
      .send({ stock_request_id: flowRequestId })
      .expect(201);
    flowDispatchId = dispatchDraft.body.id as string;
    const dispatchItemId = dispatchDraft.body.items[0].id as string;
    const listedDispatches = await request(app.getHttpServer())
      .get('/dispatches')
      .expect(200);
    expect(
      listedDispatches.body.items.some(
        (item: { id: string }) => item.id === flowDispatchId,
      ),
    ).toBe(true);
    await request(app.getHttpServer())
      .get(`/dispatches/${flowDispatchId}`)
      .expect(200)
      .expect(({ body }) => expect(body.id).toBe(flowDispatchId));
    activeActorId = unassignedUserId;
    const unassignedDispatches = await request(app.getHttpServer())
      .get('/dispatches')
      .expect(200);
    expect(unassignedDispatches.body.items).toEqual([]);
    await request(app.getHttpServer())
      .get(`/dispatches/${flowDispatchId}`)
      .expect(404);
    await request(app.getHttpServer())
      .post('/dispatches')
      .set('Idempotency-Key', randomUUID())
      .send({ stock_request_id: flowRequestId })
      .expect(403);
    activeActorId = reporterId;

    const postedDispatch = await request(app.getHttpServer())
      .post(`/dispatches/${flowDispatchId}/dispatch`)
      .set('Idempotency-Key', randomUUID())
      .send({})
      .expect(201);
    expect(postedDispatch.body.status).toBe('IN_TRANSIT');

    const receivedDispatch = await request(app.getHttpServer())
      .post(`/dispatches/${flowDispatchId}/receive`)
      .set('Idempotency-Key', randomUUID())
      .send({
        items: [{ dispatch_item_id: dispatchItemId, quantity_received: '8' }],
      })
      .expect(201);
    expect(receivedDispatch.body.status).toBe('RECEIVED');

    const transferIn = await db
      .selectFrom('inventory_movements')
      .innerJoin(
        'dispatch_receipt_items',
        'dispatch_receipt_items.id',
        'inventory_movements.dispatch_receipt_item_id',
      )
      .innerJoin(
        'dispatch_receipts',
        'dispatch_receipts.id',
        'dispatch_receipt_items.dispatch_receipt_id',
      )
      .select('inventory_movements.id')
      .where('dispatch_receipts.dispatch_id', '=', flowDispatchId)
      .executeTakeFirstOrThrow();
    await db
      .updateTable('inventory_movements')
      .set({ created_at: new Date(`${businessDate}T02:00:00.000Z`) })
      .where('id', '=', transferIn.id)
      .execute();

    const createdReport = await request(app.getHttpServer())
      .post(`/branches/${flowBranchId}/daily-reports`)
      .set('Idempotency-Key', randomUUID())
      .send({ business_date: businessDate });
    expect(
      createdReport.status,
      `business_date=${businessDate}; response=${JSON.stringify(createdReport.body)}`,
    ).toBe(201);
    createdReports.push(createdReport.body.id as string);
    const reportItem = createdReport.body.items.find(
      (item: { stock_item_id: string }) =>
        item.stock_item_id === flowStockItemId,
    );
    expect({
      opening: normalizeDecimal(reportItem.opening_quantity),
      receipts: normalizeDecimal(reportItem.receipt_quantity),
      ledgerClosing: normalizeDecimal(reportItem.ledger_closing_quantity),
    }).toEqual({ opening: '0', receipts: '8', ledgerClosing: '8' });

    const reportUrlForFlow = `/branches/${flowBranchId}/daily-reports/${createdReport.body.id}`;
    await request(app.getHttpServer())
      .put(reportUrlForFlow)
      .send({
        items: [
          {
            stock_item_id: flowStockItemId,
            physical_closing_quantity: '7.5',
            waste_quantity: '0.5',
            waste_reason: 'Spoiled during service',
            adjustment_quantity: '0',
          },
        ],
      })
      .expect(200);
    const submittedReport = await request(app.getHttpServer())
      .post(`${reportUrlForFlow}/submit`)
      .expect(200);
    expect(submittedReport.body.status).toBe('SUBMITTED');

    activeActorId = reviewerId;
    const approvedReport = await request(app.getHttpServer())
      .post(`${reportUrlForFlow}/approve`)
      .expect(200);
    expect(approvedReport.body.status).toBe('APPROVED');
    expect(
      normalizeDecimal(approvedReport.body.items[0].expected_closing_quantity),
    ).toBe('7.5');

    const balances = await Promise.all([
      db
        .selectFrom('commissary_inventory')
        .select('quantity_on_hand')
        .where('stock_item_id', '=', flowStockItemId)
        .executeTakeFirstOrThrow(),
      db
        .selectFrom('branch_inventory')
        .select('quantity_on_hand')
        .where('branch_id', '=', flowBranchId)
        .where('stock_item_id', '=', flowStockItemId)
        .executeTakeFirstOrThrow(),
    ]);
    expect(normalizeDecimal(balances[0].quantity_on_hand)).toBe('4');
    expect(normalizeDecimal(balances[1].quantity_on_hand)).toBe('7.5');
  });
});
