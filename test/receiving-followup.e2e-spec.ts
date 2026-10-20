import '../src/config/load-env';
import {
  ExecutionContext,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  down as shiftsDown,
  up as shiftsUp,
} from '../src/database/migrations/20261020234124_register_shifts_and_business_day';
import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import request from 'supertest';
import type { App } from 'supertest/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { AuthGatewayGuard } from '../src/common/guards/auth-gateway.guard';
import { AuthGuard } from '../src/common/guards/auth.guard';
import { DATABASE } from '../src/database/database.module';
import type { DB } from '../src/database/db';
import { ReceivingRemindersRepository } from '../src/modules/notifications/receiving-reminders.repository';
import {
  up,
  down,
} from '../src/database/migrations/20261020202353_dispatch_receiving_followup';

describe('receiving follow-up (disposable database)', () => {
  let app: INestApplication<App>;
  let db: Kysely<DB>;
  let userId: string;
  let branchId: string;
  let receiverId: string;
  let reviewerId: string;
  let otherId: string;
  let stockId: string;
  async function staff(name: string, permissions: string[], branch: string) {
    const role = await db
      .insertInto('auth.roles')
      .values({
        code: `N_${randomUUID().slice(0, 8).toUpperCase()}`,
        role_name: `${name} ${randomUUID()}`,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const grants = await db
      .selectFrom('auth.permissions')
      .select('id')
      .where(sql<string>`module_key || '.' || action_key`, 'in', permissions)
      .execute();
    await db
      .insertInto('auth.role_permissions')
      .values(grants.map(({ id }) => ({ role_id: role.id, permission_id: id })))
      .execute();
    const user = await db
      .insertInto('auth.users')
      .values({
        email: `${randomUUID()}@example.test`,
        full_name: name,
        contact_number: randomUUID().slice(0, 20),
        hashed_password: 'test-only',
        role_id: role.id,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('auth.branch_users')
      .values({ user_id: user.id, branch_id: branch })
      .execute();
    return user.id;
  }
  async function inbox(user: string, query = '') {
    return (
      await request(app.getHttpServer())
        .get(`/notifications?page_size=50${query}`)
        .set('x-test-user', user)
        .expect(200)
    ).body;
  }
  async function send(quantity = '4', key = randomUUID()) {
    return request(app.getHttpServer())
      .post('/dispatches/send')
      .set('Idempotency-Key', key)
      .send({
        branch_id: branchId,
        delivered_by_name: 'Juan Dela Cruz',
        items: [{ stock_item_id: stockId, quantity_dispatched: quantity }],
      });
  }
  beforeAll(async () => {
    const name = new URL(process.env.DATABASE_URL!).pathname.slice(1);
    if (
      !name.startsWith('coms_dispatch_test_') ||
      name !== process.env.COMS_TEST_DATABASE_NAME
    )
      throw new Error('Use scripts/test-disposable-db.cjs');
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideGuard(AuthGatewayGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(AuthGuard)
      .useValue({
        canActivate: (context: ExecutionContext) => {
          const req = context.switchToHttp().getRequest();
          req.user = { id: req.headers['x-test-user'] ?? userId };
          return true;
        },
      })
      .compile();
    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
    db = app.get(DATABASE);
    const role = await db
      .selectFrom('auth.roles')
      .select('id')
      .where('code', '=', 'SUPER_ADMIN')
      .executeTakeFirstOrThrow();
    const user = await db
      .insertInto('auth.users')
      .values({
        email: `${randomUUID()}@example.test`,
        full_name: 'Notification reviewer',
        contact_number: randomUUID().slice(0, 20),
        hashed_password: 'test-only',
        role_id: role.id,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    userId = user.id;
    branchId = (
      await db
        .insertInto('branches')
        .values({
          code: `N-${randomUUID().slice(0, 8)}`,
          branch_name: 'Quezon City',
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    const otherBranch = (
      await db
        .insertInto('branches')
        .values({ code: `N-${randomUUID().slice(0, 8)}`, branch_name: 'Cebu' })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    receiverId = await staff(
      'Branch team',
      [
        'dispatches.read',
        'dispatches.receive',
        'daily_reports.read',
        'daily_reports.create',
        'daily_reports.update',
        'daily_reports.submit',
      ],
      branchId,
    );
    reviewerId = await staff(
      'Review team',
      [
        'dispatches.read',
        'dispatches.shortage_close',
        'daily_reports.read',
        'daily_reports.approve',
        'daily_reports.return',
      ],
      branchId,
    );
    otherId = await staff(
      'Other branch',
      [
        'dispatches.read',
        'dispatches.receive',
        'daily_reports.read',
        'daily_reports.approve',
      ],
      otherBranch,
    );
    stockId = (
      await db
        .insertInto('stock_items')
        .values({
          stock_item_name: 'Jasmine Rice',
          created_at: sql<Date>`now() - interval '7 days'`,
          category: 'Grains',
          unit: 'kg',
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    await db
      .insertInto('commissary_inventory')
      .values({ stock_item_id: stockId, quantity_on_hand: '500' })
      .execute();
  });
  afterAll(async () => {
    await app?.close();
  });
  const api = () => request(app.getHttpServer());
  async function count(id: string, key = randomUUID(), date?: string) {
    const detail = (await api().get(`/dispatches/${id}`).expect(200)).body;
    return api()
      .post(`/dispatches/${id}/receive`)
      .set('x-test-user', receiverId)
      .set('Idempotency-Key', key)
      .send({
        items: detail.items.map((item: { id: string }) => ({
          dispatch_item_id: item.id,
          quantity_received: '4',
        })),
        delivery_date: date,
        late_reason: 'Forgot to submit the delivery count',
      });
  }
  async function report(date: string, status: string) {
    const saved = await db
      .insertInto('daily_branch_reports')
      .values({
        branch_id: branchId,
        business_date: date,
        status,
        created_by_user_id: receiverId,
        idempotency_key: randomUUID(),
        submitted_by_user_id: status === 'DRAFT' ? null : receiverId,
        submitted_at: status === 'DRAFT' ? null : new Date(),
        reviewed_by_user_id: status === 'APPROVED' ? reviewerId : null,
        reviewed_at: status === 'APPROVED' ? new Date() : null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('daily_branch_report_items')
      .values({
        daily_branch_report_id: saved.id,
        stock_item_id: stockId,
        opening_quantity: '0',
        receipt_quantity: '0',
        sale_consumption_quantity: '0',
        sale_void_reversal_quantity: '0',
        ledger_adjustment_quantity: '0',
        ledger_closing_quantity: '0',
        expected_closing_quantity: '0',
        physical_closing_quantity: '0',
      })
      .execute();
    return saved.id;
  }
  async function removeReport(id: string) {
    await db
      .deleteFrom('daily_branch_report_items')
      .where('daily_branch_report_id', '=', id)
      .execute();
    await db
      .deleteFrom('daily_branch_report_events')
      .where('daily_branch_report_id', '=', id)
      .execute();
    await db.deleteFrom('daily_branch_reports').where('id', '=', id).execute();
  }
  async function yesterday() {
    const row = await sql<{
      date: string;
    }>`SELECT ((now() AT TIME ZONE 'Asia/Manila')::date - 1)::text AS date`.execute(
      db,
    );
    return row.rows[0].date;
  }
  it('persists deadlines and rejects expired values or retry payload changes', async () => {
    const receive_by = new Date(Date.now() + 3600000).toISOString();
    const key = randomUUID();
    const payload = {
      branch_id: branchId,
      delivered_by_name: 'Juan',
      receive_by,
      items: [{ stock_item_id: stockId, quantity_dispatched: '4' }],
    };
    const sent = await api()
      .post('/dispatches/send')
      .set('Idempotency-Key', key)
      .send(payload)
      .expect(201);
    expect(sent.body.receive_by).toBe(receive_by);
    expect(sent.body.receiving_status).toBe('AWAITING_COUNT');
    await api()
      .post('/dispatches/send')
      .set('Idempotency-Key', key)
      .send({
        ...payload,
        receive_by: new Date(Date.now() + 7200000).toISOString(),
      })
      .expect(409);
    await api()
      .post('/dispatches/send')
      .set('Idempotency-Key', randomUUID())
      .send({ ...payload, receive_by: '2000-01-01T00:00:00Z' })
      .expect(400);
  });
  it('sends a single grouped reminder under concurrent sweeps, with system actor and scoped recipients', async () => {
    const first = await send();
    const second = await send();
    await db
      .updateTable('dispatches')
      .set({ receive_by: sql<Date>`now() - interval '1 hour'` })
      .where('id', 'in', [first.body.id, second.body.id])
      .execute();
    const worker = app.get(ReceivingRemindersRepository);
    await Promise.all([worker.sweep(), worker.sweep()]);
    for (const recipient of [receiverId, reviewerId]) {
      const entries = (await inbox(recipient)).items.filter(
        (n: { kind: string }) => n.kind === 'DISPATCH_OVERDUE',
      );
      expect(entries).toHaveLength(1);
      expect(entries[0].overdue_count).toBe(2);
    }
    for (const recipient of [userId, otherId])
      expect(
        (await inbox(recipient)).items.some(
          (n: { kind: string }) => n.kind === 'DISPATCH_OVERDUE',
        ),
      ).toBe(false);
    await api()
      .patch('/notifications/read-all')
      .set('x-test-user', receiverId)
      .expect(200);
    const list = await api()
      .get('/dispatches?receiving_status=OVERDUE')
      .set('x-test-user', receiverId)
      .expect(200);
    expect(list.body.total).toBe(2);
    expect((await count(first.body.id)).status).toBe(201);
    expect(
      (await api().get('/dispatches?receiving_status=OVERDUE').expect(200)).body
        .total,
    ).toBe(1);
  });
  it('requires and snapshots not-arrived explanations for report submission', async () => {
    const date = await yesterday();
    const sent = await send();
    await db
      .updateTable('dispatches')
      .set({
        dispatched_at: sql<Date>`${date}::date::timestamp AT TIME ZONE 'Asia/Manila'`,
      })
      .where('id', '=', sent.body.id)
      .execute();
    const id = await report(date, 'DRAFT');
    await api()
      .post(`/branches/${branchId}/daily-reports/${id}/submit`)
      .set('x-test-user', receiverId)
      .send({})
      .expect(409);
    const res = await api()
      .post(`/branches/${branchId}/daily-reports/${id}/submit`)
      .set('x-test-user', receiverId)
      .send({
        delivery_exceptions: [
          {
            dispatch_id: sent.body.id,
            reason: 'Courier had not arrived by closing',
          },
        ],
      })
      .expect(200);
    expect(res.body.delivery_exceptions[0].dispatch_id).toBe(sent.body.id);
    await removeReport(id);
  });
  it('holds a late count, blocks approval, and posts exactly once after returning the report', async () => {
    const date = await yesterday();
    const sent = await send();
    await db
      .updateTable('dispatches')
      .set({
        dispatched_at: sql<Date>`${date}::date::timestamp AT TIME ZONE 'Asia/Manila'`,
      })
      .where('id', '=', sent.body.id)
      .execute();
    const reportId = await report(date, 'SUBMITTED');
    const key = randomUUID();
    const held = await count(sent.body.id, key, date);
    expect(held.status).toBe(201);
    expect(held.body.receiving_outcome).toBe('REVIEW_REQUIRED');
    expect(held.body.counted_at).toBeNull();
    expect(held.body.receiving_status).toBe('REVIEW');
    expect(
      (await count(sent.body.id, key, date)).body.late_counts,
    ).toHaveLength(1);
    const caseId = held.body.late_counts[0].id;
    await api()
      .post(`/dispatches/${sent.body.id}/late-counts/${caseId}/review`)
      .set('x-test-user', otherId)
      .send({ action: 'POST' })
      .expect(403);
    await api()
      .post(`/branches/${branchId}/daily-reports/${reportId}/approve`)
      .set('x-test-user', reviewerId)
      .expect(409);
    await api()
      .post(`/branches/${branchId}/daily-reports/${reportId}/return`)
      .set('x-test-user', reviewerId)
      .send({ reason: 'Late count needs reconciliation' })
      .expect(200);
    for (let i = 0; i < 2; i++)
      await api()
        .post(`/dispatches/${sent.body.id}/late-counts/${caseId}/review`)
        .set('x-test-user', reviewerId)
        .send({ action: 'POST' })
        .expect(201);
    const receipts = await db
      .selectFrom('dispatch_receipts')
      .selectAll()
      .where('dispatch_id', '=', sent.body.id)
      .execute();
    expect(receipts).toHaveLength(1);
    const detail = (await api().get(`/dispatches/${sent.body.id}`).expect(200))
      .body;
    expect(detail.counted_by_user_id).toBe(receiverId);
    expect(detail.late_counts[0].status).toBe('POSTED');
    await db
      .updateTable('daily_branch_report_items')
      .set({ physical_closing_quantity: '4' })
      .where('daily_branch_report_id', '=', reportId)
      .execute();
    const pendingReport = (
      await api()
        .get(`/branches/${branchId}/daily-reports/${reportId}`)
        .expect(200)
    ).body;
    const submitted = await api()
      .post(`/branches/${branchId}/daily-reports/${reportId}/submit`)
      .set('x-test-user', receiverId)
      .send({
        delivery_exceptions: pendingReport.pending_deliveries.map(
          (item: { id: string }) => ({
            dispatch_id: item.id,
            reason: 'Not arrived by closing',
          }),
        ),
      })
      .expect(200);
    expect(Number(submitted.body.items[0].receipt_quantity)).toBe(4);
    const beforeApproval = await db
      .selectFrom('branch_inventory')
      .select('quantity_on_hand')
      .where('branch_id', '=', branchId)
      .where('stock_item_id', '=', stockId)
      .executeTakeFirst();
    await api()
      .post(`/branches/${branchId}/daily-reports/${reportId}/approve`)
      .set('x-test-user', reviewerId)
      .expect(200);
    expect(
      await db
        .selectFrom('branch_inventory')
        .select('quantity_on_hand')
        .where('branch_id', '=', branchId)
        .where('stock_item_id', '=', stockId)
        .executeTakeFirst(),
    ).toEqual(beforeApproval);

    await removeReport(reportId);
  });
  it('holds approved-report cases without changing inventory and allows an audited return', async () => {
    const date = await yesterday();
    const sent = await send();
    await db
      .updateTable('dispatches')
      .set({
        dispatched_at: sql<Date>`${date}::date::timestamp AT TIME ZONE 'Asia/Manila'`,
      })
      .where('id', '=', sent.body.id)
      .execute();
    const reportId = await report(date, 'APPROVED');
    const before = await db
      .selectFrom('branch_inventory')
      .select('quantity_on_hand')
      .where('branch_id', '=', branchId)
      .where('stock_item_id', '=', stockId)
      .executeTakeFirst();
    const held = await count(sent.body.id, randomUUID(), date);
    expect(held.status).toBe(201);
    const path = `/dispatches/${sent.body.id}/late-counts/${held.body.late_counts[0].id}/review`;
    await api()
      .post(path)
      .set('x-test-user', reviewerId)
      .send({ action: 'POST' })
      .expect(409);
    expect(
      await db
        .selectFrom('branch_inventory')
        .select('quantity_on_hand')
        .where('branch_id', '=', branchId)
        .where('stock_item_id', '=', stockId)
        .executeTakeFirst(),
    ).toEqual(before);
    await api()
      .post(path)
      .set('x-test-user', reviewerId)
      .send({ action: 'RETURN', reason: 'Verify the actual delivery date' })
      .expect(201);
    await removeReport(reportId);
  });
  it('serializes approval racing with a late count without posting stock twice', async () => {
    const date = await yesterday();
    const sent = await send();
    await db
      .updateTable('dispatches')
      .set({
        dispatched_at: sql<Date>`${date}::date::timestamp AT TIME ZONE 'Asia/Manila'`,
      })
      .where('id', '=', sent.body.id)
      .execute();
    const reportId = await report(date, 'SUBMITTED');
    const before = await db
      .selectFrom('branch_inventory')
      .select('quantity_on_hand')
      .where('branch_id', '=', branchId)
      .where('stock_item_id', '=', stockId)
      .executeTakeFirst();
    const [receipt, approval] = await Promise.all([
      count(sent.body.id, randomUUID(), date),
      api()
        .post(`/branches/${branchId}/daily-reports/${reportId}/approve`)
        .set('x-test-user', reviewerId),
    ]);
    expect(receipt.status).toBe(201);
    expect(receipt.body.receiving_outcome).toBe('REVIEW_REQUIRED');
    expect([200, 409]).toContain(approval.status);
    expect(
      await db
        .selectFrom('branch_inventory')
        .select('quantity_on_hand')
        .where('branch_id', '=', branchId)
        .where('stock_item_id', '=', stockId)
        .executeTakeFirst(),
    ).toEqual(before);
    await removeReport(reportId);
  });
  it('round-trips the additive migration without removing dispatches', async () => {
    const before = await db
      .selectFrom('dispatches')
      .select(sql<number>`count(*)::int`.as('total'))
      .executeTakeFirstOrThrow();
    await db.transaction().execute(async (tx) => {
      await shiftsDown(tx);
      await down(tx);
      await up(tx);
      await shiftsUp(tx);
    });
    expect(
      await db
        .selectFrom('dispatches')
        .select(sql<number>`count(*)::int`.as('total'))
        .executeTakeFirstOrThrow(),
    ).toEqual(before);
  });
});
