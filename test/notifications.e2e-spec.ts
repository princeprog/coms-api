import {
  up as followupUp,
  down as followupDown,
} from '../src/database/migrations/20261020202353_dispatch_receiving_followup';
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
import { NotificationWriterRepository } from '../src/modules/notifications/notification-writer.repository';
import {
  up,
  down,
} from '../src/database/migrations/20261020193411_notifications';
import {
  down as comsAuthDown,
  up as comsAuthUp,
} from '../src/database/migrations/20261024171507_rename_auth_schema_to_coms_auth';

describe('notifications (disposable database)', () => {
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
      .insertInto('coms_auth.roles')
      .values({
        code: `N_${randomUUID().slice(0, 8).toUpperCase()}`,
        role_name: name,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const grants = await db
      .selectFrom('coms_auth.permissions')
      .select('id')
      .where(sql<string>`module_key || '.' || action_key`, 'in', permissions)
      .execute();
    await db
      .insertInto('coms_auth.role_permissions')
      .values(grants.map(({ id }) => ({ role_id: role.id, permission_id: id })))
      .execute();
    const user = await db
      .insertInto('coms_auth.users')
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
      .insertInto('coms_auth.branch_users')
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
      .selectFrom('coms_auth.roles')
      .select('id')
      .where('code', '=', 'SUPER_ADMIN')
      .executeTakeFirstOrThrow();
    const user = await db
      .insertInto('coms_auth.users')
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
  it('returns an empty personal inbox and authoritative unread count', async () => {
    const result = await request(app.getHttpServer())
      .get('/notifications')
      .expect(200);
    expect(result.body).toEqual({
      items: [],
      total: 0,
      page: 1,
      page_size: 10,
    });
    const count = await request(app.getHttpServer())
      .get('/notifications/unread-count')
      .expect(200);
    expect(count.body).toEqual({ unread_count: 0, latest_unread_at: null });
  });
  it('notifies receivers once for concurrent sends, without leaking quantities or alerting other branches', async () => {
    const key = randomUUID();
    const [first, retry] = await Promise.all([send('4', key), send('4', key)]);
    expect(first.status).toBe(201);
    expect(retry.body.id).toBe(first.body.id);
    const result = await inbox(receiverId);
    expect(
      result.items.filter(
        (item: { dispatch_id: string }) => item.dispatch_id === first.body.id,
      ),
    ).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      kind: 'DISPATCH_SENT',
      branch_name: 'Quezon City',
      read_at: null,
    });
    expect(result.items[0]).not.toHaveProperty('quantity_dispatched');
    const count = await request(app.getHttpServer())
      .get('/notifications/unread-count')
      .set('x-test-user', receiverId)
      .expect(200);
    expect(count.body).toEqual({
      unread_count: result.total,
      latest_unread_at: result.items[0].created_at,
    });
    expect((await inbox(otherId)).total).toBe(0);
    expect((await inbox(userId)).total).toBe(0);
    const before = result.total;
    expect((await send('99999')).status).toBe(400);
    expect((await inbox(receiverId)).total).toBe(before);
  });
  it('notifies reviewers on a mismatch and receivers only after the last variance is resolved', async () => {
    const sent = await send('4');
    expect(sent.status).toBe(201);
    const receiveKey = randomUUID();
    const receive = () =>
      request(app.getHttpServer())
        .post(`/dispatches/${sent.body.id}/receive`)
        .set('x-test-user', receiverId)
        .set('Idempotency-Key', receiveKey)
        .send({
          items: [
            { dispatch_item_id: sent.body.items[0].id, quantity_received: '2' },
          ],
        });
    expect((await receive()).status).toBe(201);
    expect((await receive()).status).toBe(201);
    const review = (await inbox(reviewerId)).items.filter(
      (item: { dispatch_id: string }) => item.dispatch_id === sent.body.id,
    );
    expect(review.map((item: { kind: string }) => item.kind)).toEqual([
      'DISPATCH_DISCREPANCY',
    ]);
    expect((await inbox(userId)).items[0].kind).toBe('DISPATCH_DISCREPANCY');
    const close = (key: string) =>
      request(app.getHttpServer())
        .post(`/dispatches/${sent.body.id}/shortage-closures`)
        .set('x-test-user', reviewerId)
        .set('Idempotency-Key', key)
        .send({
          outcome: 'LOST',
          reason: 'Confirmed missing in transit',
          items: [
            { dispatch_item_id: sent.body.items[0].id, quantity_closed: '1' },
          ],
        });
    expect((await close(randomUUID())).status).toBe(201);
    expect(
      (await inbox(receiverId)).items.filter(
        (item: { dispatch_id: string; kind: string }) =>
          item.dispatch_id === sent.body.id &&
          item.kind === 'DISPATCH_RESOLVED',
      ),
    ).toHaveLength(0);
    const key = randomUUID();
    expect((await close(key)).status).toBe(201);
    expect((await close(key)).status).toBe(201);
    expect(
      (await inbox(receiverId)).items.filter(
        (item: { dispatch_id: string; kind: string }) =>
          item.dispatch_id === sent.body.id &&
          item.kind === 'DISPATCH_RESOLVED',
      ),
    ).toHaveLength(1);
    expect(
      (await inbox(userId)).items.some(
        (item: { kind: string }) => item.kind === 'DISPATCH_RESOLVED',
      ),
    ).toBe(false);
  });
  it('excludes the actor, inactive accounts and readers without receiving permission', async () => {
    const sender = await staff(
      'Sender and receiver',
      [
        'dispatches.read',
        'dispatches.create',
        'dispatches.dispatch',
        'dispatches.receive',
      ],
      branchId,
    );
    const reader = await staff('Read only', ['dispatches.read'], branchId);
    const inactive = await staff(
      'Inactive receiver',
      ['dispatches.read', 'dispatches.receive'],
      branchId,
    );
    await db
      .updateTable('coms_auth.users')
      .set({ is_active: false })
      .where('id', '=', inactive)
      .execute();
    const sent = await request(app.getHttpServer())
      .post('/dispatches/send')
      .set('x-test-user', sender)
      .set('Idempotency-Key', randomUUID())
      .send({
        branch_id: branchId,
        delivered_by_name: 'Juan Dela Cruz',
        items: [{ stock_item_id: stockId, quantity_dispatched: '1' }],
      })
      .expect(201);
    const recipients = await db
      .selectFrom('notification_recipients as nr')
      .innerJoin('notification_events as ne', 'ne.id', 'nr.event_id')
      .select('nr.user_id')
      .where('ne.dispatch_id', '=', sent.body.id)
      .execute();
    expect(recipients.map((row) => row.user_id)).toEqual([receiverId]);
    expect((await inbox(sender)).total).toBe(0);
    expect((await inbox(reader)).total).toBe(0);
    const before = (await inbox(reviewerId)).total;
    await request(app.getHttpServer())
      .post(`/dispatches/${sent.body.id}/receive`)
      .set('x-test-user', receiverId)
      .set('Idempotency-Key', randomUUID())
      .send({
        items: [
          { dispatch_item_id: sent.body.items[0].id, quantity_received: '1' },
        ],
      })
      .expect(201);
    expect((await inbox(reviewerId)).total).toBe(before);
  });
  it('supports individual and bulk read states without crossing users', async () => {
    const [item] = (await inbox(receiverId)).items;
    await request(app.getHttpServer())
      .patch(`/notifications/${item.id}/read`)
      .set('x-test-user', otherId)
      .expect(404);
    await request(app.getHttpServer())
      .patch(`/notifications/${item.id}/read`)
      .expect(404);
    const first = await request(app.getHttpServer())
      .patch(`/notifications/${item.id}/read`)
      .set('x-test-user', receiverId)
      .expect(200);
    const second = await request(app.getHttpServer())
      .patch(`/notifications/${item.id}/read`)
      .set('x-test-user', receiverId)
      .expect(200);
    expect(second.body.read_at).toBe(first.body.read_at);
    await request(app.getHttpServer())
      .patch('/notifications/read-all')
      .set('x-test-user', receiverId)
      .expect(200);
    expect((await inbox(receiverId, '&status=unread')).total).toBe(0);
    expect((await inbox(reviewerId, '&status=unread')).total).toBeGreaterThan(
      0,
    );
    await send();
    expect((await inbox(receiverId, '&status=unread')).total).toBe(1);
  });
  it('handles report submission, correction, resubmission and approval as distinct events', async () => {
    await db
      .updateTable('stock_items')
      .set({ created_at: new Date('2026-01-01T00:00:00Z') })
      .where('id', '=', stockId)
      .execute();
    await db
      .insertInto('inventory_movements')
      .values({
        inventory_scope: 'BRANCH',
        branch_id: branchId,
        stock_item_id: stockId,
        movement_type: 'ADJUSTMENT',
        quantity_delta: '1',
        reason: 'Opening balance',
        actor_user_id: userId,
        created_at: new Date('2026-01-01T00:00:00Z'),
      })
      .execute();
    const root = `/branches/${branchId}/daily-reports`;
    const created = await request(app.getHttpServer())
      .post(root)
      .set('x-test-user', receiverId)
      .set('Idempotency-Key', randomUUID())
      .send({ business_date: '2026-01-10' })
      .expect(201);
    const reportId = created.body.id;
    await request(app.getHttpServer())
      .put(`${root}/${reportId}`)
      .set('x-test-user', receiverId)
      .send({
        items: created.body.items.map((item: { stock_item_id: string }) => ({
          stock_item_id: item.stock_item_id,
          physical_closing_quantity: '0',
          waste_quantity: '0',
          adjustment_quantity: '0',
        })),
      })
      .expect(200);
    const submit = () =>
      request(app.getHttpServer())
        .post(`${root}/${reportId}/submit`)
        .set('x-test-user', receiverId);
    await submit().expect(200);
    await submit().expect(200);
    const events = async (user: string) =>
      (await inbox(user, '&type=reports')).items
        .filter((item: { report_id: string }) => item.report_id === reportId)
        .map((item: { kind: string }) => item.kind);
    expect(await events(reviewerId)).toEqual(['REPORT_SUBMITTED']);
    expect(await events(userId)).toEqual(['REPORT_SUBMITTED']);
    expect(await events(receiverId)).toEqual([]);
    const returnReport = () =>
      request(app.getHttpServer())
        .post(`${root}/${reportId}/return`)
        .set('x-test-user', reviewerId)
        .send({ reason: 'Please verify the closing count.' });
    await returnReport().expect(200);
    await returnReport().expect(200);
    expect(await events(receiverId)).toEqual(['REPORT_RETURNED']);
    await submit().expect(200);
    expect(await events(reviewerId)).toEqual([
      'REPORT_SUBMITTED',
      'REPORT_SUBMITTED',
    ]);
    await request(app.getHttpServer())
      .post(`${root}/${reportId}/approve`)
      .set('x-test-user', reviewerId)
      .expect(200);
    await request(app.getHttpServer())
      .post(`${root}/${reportId}/approve`)
      .set('x-test-user', reviewerId)
      .expect(200);
    expect(await events(receiverId)).toEqual([
      'REPORT_APPROVED',
      'REPORT_RETURNED',
    ]);
  });
  it('rechecks branch, read permission, role and account access', async () => {
    const [item] = (await inbox(receiverId)).items;
    await db
      .deleteFrom('coms_auth.branch_users')
      .where('user_id', '=', receiverId)
      .execute();
    expect((await inbox(receiverId)).total).toBe(0);
    await request(app.getHttpServer())
      .patch(`/notifications/${item.id}/read`)
      .set('x-test-user', receiverId)
      .expect(404);
    expect(
      (
        await request(app.getHttpServer())
          .get('/notifications/unread-count')
          .set('x-test-user', receiverId)
      ).body.unread_count,
    ).toBe(0);
    await db
      .insertInto('coms_auth.branch_users')
      .values({ user_id: receiverId, branch_id: branchId })
      .execute();
    const user = await db
      .selectFrom('coms_auth.users')
      .select('role_id')
      .where('id', '=', receiverId)
      .executeTakeFirstOrThrow();
    await db
      .updateTable('coms_auth.roles')
      .set({ is_active: false })
      .where('id', '=', user.role_id!)
      .execute();
    await request(app.getHttpServer())
      .get('/notifications')
      .set('x-test-user', receiverId)
      .expect(403);
    await db
      .updateTable('coms_auth.roles')
      .set({ is_active: true })
      .where('id', '=', user.role_id!)
      .execute();
    await db
      .updateTable('coms_auth.users')
      .set({ is_active: false })
      .where('id', '=', receiverId)
      .execute();
    await request(app.getHttpServer())
      .get('/notifications')
      .set('x-test-user', receiverId)
      .expect(401);
    await db
      .updateTable('coms_auth.users')
      .set({ is_active: true })
      .where('id', '=', receiverId)
      .execute();
    const readGrants = await db
      .selectFrom('coms_auth.permissions')
      .select('id')
      .where('action_key', '=', 'read')
      .execute();
    await db
      .deleteFrom('coms_auth.role_permissions')
      .where('role_id', '=', user.role_id!)
      .where(
        'permission_id',
        'in',
        readGrants.map(({ id }) => id),
      )
      .execute();
    expect((await inbox(receiverId)).total).toBe(0);
  });
  it('rejects unsupported page sizes and filters', async () => {
    for (const query of [
      'page_size=20',
      'page=0',
      'status=invalid',
      'type=invalid',
    ])
      await request(app.getHttpServer())
        .get(`/notifications?${query}`)
        .expect(400);
  });
  it('keeps a stable paginated inbox and authoritative unread count', async () => {
    // Use a fresh receiver; granting access never backfills old events.
    const recipient = await staff(
      'Pagination receiver',
      ['dispatches.read', 'dispatches.receive'],
      branchId,
    );
    for (let index = 0; index < 12; index++)
      expect((await send('1')).status).toBe(201);
    const first = (
      await request(app.getHttpServer())
        .get('/notifications')
        .set('x-test-user', recipient)
        .expect(200)
    ).body;
    const second = (
      await request(app.getHttpServer())
        .get('/notifications?page=2')
        .set('x-test-user', recipient)
        .expect(200)
    ).body;
    expect(first.items).toHaveLength(10);
    expect(second.items).toHaveLength(2);
    expect(first.total).toBe(12);
    expect(
      new Set([...first.items, ...second.items].map((item) => item.id)).size,
    ).toBe(12);
    for (const size of [30, 50])
      expect(
        (
          await request(app.getHttpServer())
            .get(`/notifications?page_size=${size}`)
            .set('x-test-user', recipient)
            .expect(200)
        ).body.items,
      ).toHaveLength(12);
    expect(
      (
        await request(app.getHttpServer())
          .get('/notifications/unread-count')
          .set('x-test-user', recipient)
      ).body.unread_count,
    ).toBe(12);
    expect((await inbox(recipient, '&type=reports')).total).toBe(0);
  });
  it('deduplicates source events and rolls back notification writes with their transaction', async () => {
    const sent = await send('1');
    const event = await db
      .selectFrom('dispatch_events')
      .selectAll()
      .where('dispatch_id', '=', sent.body.id)
      .executeTakeFirstOrThrow();
    const input = {
      kind: 'DISPATCH_SENT' as const,
      dispatch_id: sent.body.id as string,
      dispatch_event_id: event.id,
      branch_id: branchId,
      actor_user_id: userId,
    };
    const writer = app.get(NotificationWriterRepository);
    const count = async () =>
      (
        await db
          .selectFrom('notification_events')
          .select(sql<number>`count(*)::int`.as('total'))
          .executeTakeFirstOrThrow()
      ).total;
    const before = await count();
    await db.transaction().execute((tx) => writer.publish(tx, input));
    expect(await count()).toBe(before);
    await expect(
      db.transaction().execute(async (tx) => {
        const source = await tx
          .insertInto('dispatch_events')
          .values({
            dispatch_id: input.dispatch_id,
            event_type: 'DISPATCHED',
            actor_user_id: userId,
            idempotency_key: randomUUID(),
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await writer.publish(tx, { ...input, dispatch_event_id: source.id });
        throw new Error('Rollback probe');
      }),
    ).rejects.toThrow('Rollback probe');
    expect(await count()).toBe(before);
  });
  it('leaves a concurrently committed notification unread during mark-all', async () => {
    const recipient = await staff(
      'Concurrent receiver',
      ['dispatches.read', 'dispatches.receive'],
      branchId,
    );
    await send('1');
    let release!: () => void;
    let ready!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inserted = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const source = await db
      .selectFrom('notification_events')
      .select('id')
      .limit(1)
      .executeTakeFirstOrThrow();
    const write = db.transaction().execute(async (tx) => {
      const row = await tx
        .insertInto('notification_recipients')
        .values({ event_id: source.id, user_id: recipient })
        .returning('id')
        .executeTakeFirstOrThrow();
      ready();
      await pending;
      return row.id;
    });
    await inserted;
    await request(app.getHttpServer())
      .patch('/notifications/read-all')
      .set('x-test-user', recipient)
      .expect(200);
    release();
    const id = await write;
    expect(
      (await inbox(recipient, '&status=unread')).items.map(
        (item: { id: string }) => item.id,
      ),
    ).toEqual([id]);
  });
  it('reverses and reapplies only the notification schema', async () => {
    const before = await db
      .selectFrom('dispatches')
      .select(sql<number>`count(*)::int`.as('total'))
      .executeTakeFirstOrThrow();
    await db.transaction().execute(async (tx) => {
      // Older migrations name the auth schema, so undo the rename first.
      await comsAuthDown(tx);
      await shiftsDown(tx);
      await followupDown(tx);
      await down(tx);
      const removed = await sql<{
        name: string | null;
      }>`SELECT to_regclass('notification_events')::text AS name`.execute(tx);
      expect(removed.rows[0].name).toBeNull();
      await up(tx);
      await followupUp(tx);
      await shiftsUp(tx);
      await comsAuthUp(tx);
    });
    expect(
      await db
        .selectFrom('dispatches')
        .select(sql<number>`count(*)::int`.as('total'))
        .executeTakeFirstOrThrow(),
    ).toEqual(before);
    expect((await inbox(userId)).total).toBe(0);
  });
});
