import {
  up as reminderUp,
  down as reminderDown,
} from '../src/database/migrations/20261024230410_manual_dispatch_count_reminders';
import '../src/config/load-env';
import {
  ExecutionContext,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
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
describe('manual count reminders (disposable database)', () => {
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
  function send(quantity = '4', key = randomUUID()) {
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

  function remind(id: string, key = randomUUID(), actor = userId) {
    return request(app.getHttpServer())
      .post(`/dispatches/${id}/count-reminders`)
      .set('x-test-user', actor)
      .set('Idempotency-Key', key);
  }
  it('supports a reversible empty migration and retains existing notification constraints', async () => {
    await reminderDown(db);
    await reminderUp(db);
    const indexes = await sql<{
      indexname: string;
    }>`SELECT indexname FROM pg_indexes WHERE indexname = 'dispatch_events_count_reminder_idx'`.execute(
      db,
    );
    expect(indexes.rows).toHaveLength(1);
  });
  it('publishes one targeted reminder, exposes history, and safely retries', async () => {
    const dispatch = (await send().expect(201)).body;
    const key = randomUUID();
    const before = await db
      .selectFrom('inventory_movements')
      .select(sql<number>`count(*)::int`.as('total'))
      .executeTakeFirstOrThrow();
    const first = (await remind(dispatch.id, key).expect(201)).body;
    expect(first.count_reminder.last_sent_at).toBeTruthy();
    expect(
      Date.parse(first.count_reminder.next_allowed_at) -
        Date.parse(first.count_reminder.last_sent_at),
    ).toBe(1800000);
    await remind(dispatch.id, key).expect(201);
    expect(
      first.events.filter(
        (e: { event_type: string }) => e.event_type === 'COUNT_REMINDER_SENT',
      ),
    ).toHaveLength(1);
    expect(
      (await inbox(receiverId)).items.filter(
        (n: { kind: string }) => n.kind === 'DISPATCH_COUNT_REMINDER',
      ),
    ).toHaveLength(1);
    for (const user of [userId, reviewerId, otherId]) {
      expect(
        (await inbox(user)).items.filter(
          (n: { kind: string }) => n.kind === 'DISPATCH_COUNT_REMINDER',
        ),
      ).toHaveLength(0);
    }
    const limited = await remind(dispatch.id).expect(429);
    expect(limited.body.next_allowed_at).toBe(
      first.count_reminder.next_allowed_at,
    );
    const after = await db
      .selectFrom('inventory_movements')
      .select(sql<number>`count(*)::int`.as('total'))
      .executeTakeFirstOrThrow();
    expect(after).toEqual(before);
    expect(first.status).toBe(dispatch.status);
  });
  it('enforces sending permission, branch scope and active branches', async () => {
    const dispatch = (await send().expect(201)).body;
    await remind(dispatch.id, randomUUID(), receiverId).expect(403);
    const outsideBranch = (
      await db
        .selectFrom('coms_auth.branch_users')
        .select('branch_id')
        .where('user_id', '=', otherId)
        .executeTakeFirstOrThrow()
    ).branch_id;
    const sender = await staff(
      'Outside sender',
      ['dispatches.read', 'dispatches.dispatch'],
      outsideBranch,
    );
    await remind(dispatch.id, randomUUID(), sender).expect(404);
    await db
      .updateTable('branches')
      .set({ status: 'inactive' })
      .where('id', '=', branchId)
      .execute();
    await remind(dispatch.id).expect(404);
    await db
      .updateTable('branches')
      .set({ status: 'active' })
      .where('id', '=', branchId)
      .execute();
  });
  it('serializes competing senders and allows sending at the cooldown boundary', async () => {
    const dispatch = (await send().expect(201)).body;
    const results = await Promise.all([
      remind(dispatch.id),
      remind(dispatch.id),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 429]);
    await db
      .updateTable('dispatch_events')
      .set({ created_at: sql<Date>`clock_timestamp() - interval '30 minutes'` })
      .where('dispatch_id', '=', dispatch.id)
      .where('event_type', '=', 'COUNT_REMINDER_SENT')
      .execute();
    await remind(dispatch.id).expect(201);
  });
  it('rolls back when no receiving staff are eligible', async () => {
    const dispatch = (await send().expect(201)).body;
    await db
      .updateTable('coms_auth.users')
      .set({ is_active: false })
      .where('id', '=', receiverId)
      .execute();
    await remind(dispatch.id).expect(409);
    expect(
      await db
        .selectFrom('dispatch_events')
        .select('id')
        .where('dispatch_id', '=', dispatch.id)
        .where('event_type', '=', 'COUNT_REMINDER_SENT')
        .execute(),
    ).toHaveLength(0);
    await db
      .updateTable('coms_auth.users')
      .set({ is_active: true })
      .where('id', '=', receiverId)
      .execute();
    await remind(dispatch.id).expect(201);
  });

  it('rejects drafts and saved counts awaiting review; returned counts can be reminded', async () => {
    const draft = (
      await request(app.getHttpServer())
        .post('/dispatches')
        .set('Idempotency-Key', randomUUID())
        .send({
          branch_id: branchId,
          items: [{ stock_item_id: stockId, quantity_dispatched: '1' }],
        })
        .expect(201)
    ).body;
    await remind(draft.id).expect(409);
    const dispatch = (await send().expect(201)).body;
    const pending = await db
      .insertInto('dispatch_late_counts')
      .values({
        dispatch_id: dispatch.id,
        counted_by_user_id: receiverId,
        idempotency_key: randomUUID(),
        delivery_date: sql<Date>`current_date`,
        late_reason: 'Late delivery',
        items: JSON.stringify([
          { dispatch_item_id: dispatch.items[0].id, quantity: '4' },
        ]),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await remind(dispatch.id).expect(409);
    await db
      .updateTable('dispatch_late_counts')
      .set({
        status: 'RETURNED',
        reviewed_by_user_id: userId,
        reviewed_at: sql<Date>`now()`,
        review_reason: 'Check the count',
      })
      .where('id', '=', pending.id)
      .execute();
    await remind(dispatch.id).expect(201);
  });
  it('excludes the dispatcher and sender even if they can receive', async () => {
    const operator = await staff(
      'Sender with receive permission',
      ['dispatches.read', 'dispatches.dispatch', 'dispatches.receive'],
      branchId,
    );
    const dispatch = (await send().expect(201)).body;
    await db
      .updateTable('dispatches')
      .set({ dispatched_by_user_id: operator })
      .where('id', '=', dispatch.id)
      .execute();
    await remind(dispatch.id).expect(201);
    expect(
      (await inbox(operator)).items.filter(
        (n: { kind: string }) => n.kind === 'DISPATCH_COUNT_REMINDER',
      ),
    ).toHaveLength(0);
    const another = (await send().expect(201)).body;
    await remind(another.id, randomUUID(), operator).expect(201);
    expect(
      (await inbox(operator)).items.filter(
        (n: { kind: string }) => n.kind === 'DISPATCH_COUNT_REMINDER',
      ),
    ).toHaveLength(0);
  });
  it('serializes with count submission and acknowledges a prior retry after counting', async () => {
    const dispatch = (await send().expect(201)).body;
    const key = randomUUID();
    const receive = () =>
      request(app.getHttpServer())
        .post(`/dispatches/${dispatch.id}/receive`)
        .set('x-test-user', receiverId)
        .set('Idempotency-Key', randomUUID())
        .send({
          items: [
            { dispatch_item_id: dispatch.items[0].id, quantity_received: '4' },
          ],
        });
    const [reminder, count] = await Promise.all([
      remind(dispatch.id, key),
      receive(),
    ]);
    expect(count.status).toBe(201);
    expect([201, 409]).toContain(reminder.status);
    await remind(dispatch.id).expect(409);
    if (reminder.status === 201) await remind(dispatch.id, key).expect(201);
    const events = await db
      .selectFrom('dispatch_events')
      .selectAll()
      .where('dispatch_id', '=', dispatch.id)
      .where('event_type', '=', 'COUNT_REMINDER_SENT')
      .execute();
    expect(events.length).toBe(reminder.status === 201 ? 1 : 0);
  });
  it('rejects reused keys, missing keys and a sending role without read permission', async () => {
    const first = (await send().expect(201)).body;
    const second = (await send().expect(201)).body;
    const key = randomUUID();
    await remind(first.id, key).expect(201);
    await remind(second.id, key).expect(409);
    await request(app.getHttpServer())
      .post(`/dispatches/${second.id}/count-reminders`)
      .expect(400);
    const noRead = await staff(
      'Sending only',
      ['dispatches.dispatch'],
      branchId,
    );
    await remind(second.id, randomUUID(), noRead).expect(403);
    const list = (
      await request(app.getHttpServer())
        .get('/dispatches?page_size=50')
        .expect(200)
    ).body;
    expect(
      list.items.find((d: { id: string }) => d.id === first.id).count_reminder
        .last_sent_at,
    ).toBeTruthy();
  });
  it('keeps reminder history on schema rollback', async () => {
    await expect(reminderDown(db)).rejects.toThrow('reminder history exists');
  });
});
