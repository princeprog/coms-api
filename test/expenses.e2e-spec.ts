import '../src/config/load-env';
import {
  ValidationPipe,
  type ExecutionContext,
  type INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { AuthGatewayGuard } from '../src/common/guards/auth-gateway.guard';
import { AuthGuard } from '../src/common/guards/auth.guard';
import { DATABASE } from '../src/database/database.module';
import type { DB } from '../src/database/db';
import { openTestShift } from './shift-fixture';
import { down } from '../src/database/migrations/20261025012040_expenses_tracking';

describe('expenses (disposable database)', () => {
  let app: INestApplication;
  let db: Kysely<DB>;
  let admin: string,
    manager: string,
    outsider: string,
    reader: string,
    commissary: string,
    globalReader: string;
  let branch: string, other: string, category: string, shift: string;
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const grants = [
    'expenses.read',
    'expenses.create',
    'expenses.update',
    'expenses.void',
  ];
  const http = (actor = admin) => ({
    get: (path: string) =>
      request(app.getHttpServer()).get(path).set('x-test-user', actor),
    post: (path: string, key = randomUUID()) =>
      request(app.getHttpServer())
        .post(path)
        .set('x-test-user', actor)
        .set('Idempotency-Key', key),
    patch: (path: string, key = randomUUID()) =>
      request(app.getHttpServer())
        .patch(path)
        .set('x-test-user', actor)
        .set('Idempotency-Key', key),
  });
  const input = (extra: Record<string, unknown> = {}) => ({
    expense_date: today,
    scope: 'BRANCH',
    branch_id: branch,
    category_id: category,
    description: 'Delivery fuel',
    amount: '120.25',
    payment_method: 'CASH',
    cash_source: 'OTHER',
    cash_movement_id: null,
    payee: 'Local station',
    reference: null,
    notes: null,
    ...extra,
  });
  async function staff(keys: string[], location: string, system = false) {
    let roleId: string;
    if (system)
      roleId = (
        await db
          .selectFrom('coms_auth.roles')
          .select('id')
          .where('code', '=', 'SUPER_ADMIN')
          .executeTakeFirstOrThrow()
      ).id;
    else {
      roleId = (
        await db
          .insertInto('coms_auth.roles')
          .values({
            code: 'E_' + randomUUID().slice(0, 8).toUpperCase(),
            role_name: 'Expense test ' + randomUUID(),
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      if (keys.length)
        await sql`INSERT INTO coms_auth.role_permissions(role_id,permission_id)
        SELECT ${roleId},id FROM coms_auth.permissions WHERE module_key||'.'||action_key IN (${sql.join(keys)})`.execute(
          db,
        );
    }
    const user = (
      await db
        .insertInto('coms_auth.users')
        .values({
          email: randomUUID() + '@example.test',
          full_name: 'Expense test operator',
          contact_number: randomUUID().slice(0, 20),
          hashed_password: 'test-only',
          role_id: roleId,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    await db
      .insertInto('coms_auth.branch_users')
      .values({ user_id: user, branch_id: location })
      .execute();
    return user;
  }
  async function cash(amount = '80.50', direction = 'OUT') {
    return (
      await db
        .insertInto('register_shift_cash_movements')
        .values({
          shift_id: shift,
          actor_user_id: manager,
          direction,
          amount,
          reason: 'Bought ice',
          idempotency_key: randomUUID(),
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
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
          req.user = { id: req.headers['x-test-user'] };
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
    branch = (
      await db
        .insertInto('branches')
        .values({
          code: 'EA-' + randomUUID().slice(0, 8),
          branch_name: 'Expenses Manila',
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    other = (
      await db
        .insertInto('branches')
        .values({
          code: 'EB-' + randomUUID().slice(0, 8),
          branch_name: 'Expenses Cebu',
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    admin = await staff([], branch, true);
    manager = await staff([...grants, 'shifts.read', 'shifts.review'], branch);
    outsider = await staff(grants, other);
    reader = await staff(['expenses.read'], branch);
    commissary = await staff([...grants, 'expenses.commissary_read'], branch);
    globalReader = await staff(
      ['expenses.read', 'expenses.global_read'],
      branch,
    );
    category = (
      await db
        .selectFrom('expense_categories')
        .select('id')
        .where('name', '=', 'Transportation')
        .executeTakeFirstOrThrow()
    ).id;
    shift = await openTestShift(db, branch, manager, '500');
  }, 30000);
  afterAll(async () => {
    await app?.close();
  });

  it('limits locations, reads and mutations by capabilities and assigned branches', async () => {
    const created = await http(manager)
      .post('/expenses')
      .send(input())
      .expect(201);
    const id = created.body.record.id;
    await http(outsider)
      .get('/expenses/records/OPERATING/' + id)
      .expect(404);
    await http(reader).post('/expenses').send(input()).expect(403);
    await http(manager)
      .post('/expenses')
      .send(input({ branch_id: other }))
      .expect(403);
    await http(manager)
      .post('/expenses')
      .send(input({ scope: 'COMMISSARY', branch_id: null }))
      .expect(403);
    await http(globalReader).get('/expenses?scope=COMMISSARY').expect(403);
    const locations = await http(manager)
      .get('/expenses/locations')
      .expect(200);
    expect(
      locations.body.items.map((x: { branch_id: string }) => x.branch_id),
    ).toEqual([branch]);
    const comm = await http(commissary)
      .post('/expenses')
      .send(input({ scope: 'COMMISSARY', branch_id: null }))
      .expect(201);
    expect(comm.body.record.scope).toBe('COMMISSARY');
    expect(
      (await http(manager).get('/expenses').expect(200)).body.items.every(
        (x: { branch_id: string }) => x.branch_id === branch,
      ),
    ).toBe(true);
  });

  it('validates dates, positive exact money and cash source combinations', async () => {
    for (const change of [
      { amount: '0' },
      { amount: '-1' },
      { amount: '1.234' },
      { amount: '1000000000' },
      { expense_date: '2026-02-30' },
      { expense_date: '2099-01-01' },
      { description: ' ' },
      { payment_method: 'CARD', cash_source: 'OTHER' },
      { cash_source: 'REGISTER', cash_movement_id: null },
    ])
      await http().post('/expenses').send(input(change)).expect(400);
    const created = await http()
      .post('/expenses')
      .send(input({ amount: '0.10' }))
      .expect(201);
    expect(Number(created.body.record.amount)).toBe(0.1);
    expect(created.body.record.expense_date).toBe(today);
  });

  it('handles concurrent create retries once and rejects changed key reuse', async () => {
    const key = randomUUID();
    const payload = input({ description: 'Idempotent operating expense' });
    const result = await Promise.all([
      http().post('/expenses', key).send(payload),
      http().post('/expenses', key).send(payload),
    ]);
    expect(result.map((r) => r.status)).toEqual([201, 201]);
    expect(result[0].body.record.id).toBe(result[1].body.record.id);
    expect(result[0].body.history).toHaveLength(1);
    await http()
      .post('/expenses', key)
      .send({ ...payload, amount: '120.26' })
      .expect(409);
    await http(manager).post('/expenses', key).send(payload).expect(409);
    expect(
      Number(
        (
          await db
            .selectFrom('expense_events')
            .select((e) => e.fn.countAll().as('n'))
            .where('idempotency_key', '=', key)
            .executeTakeFirstOrThrow()
        ).n,
      ),
    ).toBe(1);
  });

  it('retains correction history, rejects stale updates and removes voided values from totals', async () => {
    const payload = input({ description: 'History scenario' });
    const first = (await http().post('/expenses').send(payload).expect(201))
      .body;
    const id = first.record.id;
    const key = randomUUID();
    const correction = {
      ...payload,
      amount: '99.99',
      revision: 1,
      reason: 'Corrected the receipt amount',
    };
    const edited = (
      await http()
        .patch('/expenses/' + id, key)
        .send(correction)
        .expect(200)
    ).body;
    expect(edited.record.revision).toBe(2);
    expect(edited.history).toHaveLength(2);
    expect(
      edited.history.some(
        (x: { reason: string }) => x.reason === correction.reason,
      ),
    ).toBe(true);
    await http()
      .patch('/expenses/' + id, key)
      .send(correction)
      .expect(200);
    await http()
      .patch('/expenses/' + id)
      .send(correction)
      .expect(409);
    await http()
      .patch('/expenses/' + id)
      .send({ ...correction, revision: 2, reason: ' ' })
      .expect(400);
    const cancelKey = randomUUID();
    const cancelled = (
      await http()
        .post('/expenses/' + id + '/void', cancelKey)
        .send({ revision: 2, reason: 'Duplicate receipt' })
        .expect(201)
    ).body;
    expect(cancelled.record.status).toBe('VOIDED');
    expect(cancelled.history).toHaveLength(3);
    await http()
      .post('/expenses/' + id + '/void', cancelKey)
      .send({ revision: 2, reason: 'Duplicate receipt' })
      .expect(201);
    await http()
      .patch('/expenses/' + id)
      .send({ ...correction, revision: 3 })
      .expect(409);
    const page = (
      await http()
        .get('/expenses?search=History%20scenario&status=all')
        .expect(200)
    ).body;
    expect(page.total).toBe(1);
    expect(Number(page.summary.recorded_spending)).toBe(0);
    const event = await db
      .selectFrom('expense_events')
      .select('id')
      .where('expense_id', '=', id)
      .executeTakeFirstOrThrow();
    await expect(
      db
        .updateTable('expense_events')
        .set({ reason: 'Overwritten' })
        .where('id', '=', event.id)
        .execute(),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.deleteFrom('expense_events').where('id', '=', event.id).execute(),
    ).rejects.toThrow(/append-only/);
  });

  it('allows only one concurrent revision to win', async () => {
    const payload = input({ description: 'Concurrent correction' });
    const id = (await http().post('/expenses').send(payload).expect(201)).body
      .record.id;
    const changes = await Promise.all(
      ['10', '20'].map((amount) =>
        http()
          .patch('/expenses/' + id)
          .send({ ...payload, amount, revision: 1, reason: 'Correct amount' }),
      ),
    );
    expect(changes.map((x) => x.status).sort()).toEqual([200, 409]);
    expect(
      (
        await http()
          .get('/expenses/records/OPERATING/' + id)
          .expect(200)
      ).body.history,
    ).toHaveLength(2);
  });

  it('keeps categories administrable, reserved and historically readable', async () => {
    await http(manager)
      .post('/expenses/categories')
      .send({ name: 'New category' })
      .expect(403);
    const c = (
      await http()
        .post('/expenses/categories')
        .send({ name: 'Equipment hire' })
        .expect(201)
    ).body;
    await http()
      .post('/expenses/categories')
      .send({ name: ' equipment HIRE ' })
      .expect(409);
    await http()
      .post('/expenses/categories')
      .send({ name: 'Stock purchases' })
      .expect(400);
    const payload = input({ category_id: c.id });
    const e = (await http().post('/expenses').send(payload).expect(201)).body
      .record;
    await http()
      .patch('/expenses/categories/' + c.id)
      .send({ is_active: false })
      .expect(200);
    await http().post('/expenses').send(payload).expect(400);
    await http()
      .patch('/expenses/' + e.id)
      .send({
        ...payload,
        notes: 'Historic category retained',
        revision: 1,
        reason: 'Added receipt detail',
      })
      .expect(200);
    expect(
      (
        await http()
          .get('/expenses/records/OPERATING/' + e.id)
          .expect(200)
      ).body.record.category_name,
    ).toBe('Equipment hire');
  });

  it('links cash-outs exactly once without changing cash or inventory', async () => {
    const movement = await cash();
    const before = await db
      .selectFrom('register_shift_cash_movements')
      .selectAll()
      .where('shift_id', '=', shift)
      .orderBy('id')
      .execute();
    const stockBefore = await db
      .selectFrom('inventory_movements')
      .select((e) => e.fn.countAll().as('n'))
      .executeTakeFirstOrThrow();
    const payload = input({
      amount: '80.50',
      cash_source: 'REGISTER',
      cash_movement_id: movement,
    });
    const list = (
      await http(manager)
        .get('/expenses/cash-outs?branch_id=' + branch)
        .expect(200)
    ).body;
    expect(list.items.some((x: { id: string }) => x.id === movement)).toBe(
      true,
    );
    await http(reader)
      .get('/expenses/cash-outs?branch_id=' + branch)
      .expect(403);
    await http(outsider)
      .get('/expenses/cash-outs?branch_id=' + branch)
      .expect(403);
    const attempts = await Promise.all([
      http(manager).post('/expenses').send(payload),
      http(manager).post('/expenses').send(payload),
    ]);
    expect(attempts.map((x) => x.status).sort()).toEqual([201, 409]);
    const saved = attempts.find((x) => x.status === 201)!.body.record;
    await http(manager)
      .patch('/expenses/' + saved.id)
      .send({
        ...payload,
        amount: '80.51',
        revision: 1,
        reason: 'Attempt to change linked amount',
      })
      .expect(409);
    await http(manager)
      .patch('/expenses/' + saved.id)
      .send({
        ...payload,
        notes: 'Receipt attached to records',
        revision: 1,
        reason: 'Added notes',
      })
      .expect(200);
    expect(
      (
        await http(manager)
          .get('/expenses/cash-outs?branch_id=' + branch)
          .expect(200)
      ).body.items.some((x: { id: string }) => x.id === movement),
    ).toBe(false);
    await http(manager)
      .post('/expenses/' + saved.id + '/void')
      .send({ revision: 2, reason: 'Correct category via replacement' })
      .expect(201);
    await http(manager).post('/expenses').send(payload).expect(201);
    expect(
      await db
        .selectFrom('register_shift_cash_movements')
        .selectAll()
        .where('shift_id', '=', shift)
        .orderBy('id')
        .execute(),
    ).toEqual(before);
    expect(
      await db
        .selectFrom('inventory_movements')
        .select((e) => e.fn.countAll().as('n'))
        .executeTakeFirstOrThrow(),
    ).toEqual(stockBefore);
  });

  it('rejects wrong cash movement direction, branch and amount', async () => {
    const incoming = await cash('10', 'IN'),
      outgoing = await cash('25');
    for (const extra of [
      { cash_movement_id: incoming, amount: '10' },
      { cash_movement_id: outgoing, amount: '24' },
      { cash_movement_id: outgoing, amount: '25', branch_id: other },
    ])
      await http()
        .post('/expenses')
        .send(input({ cash_source: 'REGISTER', ...extra }))
        .expect(400);
  });

  it('includes existing purchase values once, scoped to commissary, without exposing their mutation routes', async () => {
    const stock = (
      await db
        .insertInto('stock_items')
        .values({
          stock_item_name: 'Expenses integration rice',
          category: 'Rice',
          unit: 'kg',
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    const supplier = (
      await db
        .insertInto('suppliers')
        .values({ supplier_name: 'Spending audit supplier' })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    const supplied = (
      await http()
        .post('/supplier-receipts')
        .send({
          supplier_id: supplier,
          received_at: today,
          items: [
            {
              stock_item_id: stock,
              quantity_received: '2',
              unit_cost: '12.35',
            },
          ],
        })
        .expect(201)
    ).body;
    await http()
      .post('/direct-purchases')
      .send({
        purchase_date: today,
        store_name: 'Spending audit market',
        items: [
          { stock_item_id: stock, quantity_received: '3', unit_cost: '0.10' },
        ],
      })
      .expect(201);
    await http()
      .post('/expenses')
      .send(
        input({
          scope: 'COMMISSARY',
          branch_id: null,
          description: 'Spending audit transport',
          amount: '5',
        }),
      )
      .expect(201);
    const list = (
      await http().get('/expenses?search=Spending%20audit').expect(200)
    ).body;
    expect(list.total).toBe(3);
    expect(Number(list.summary.stock_purchases)).toBe(25);
    expect(Number(list.summary.operating_expenses)).toBe(5);
    expect(Number(list.summary.recorded_spending)).toBe(30);
    expect(
      list.items
        .filter((x: { source: string }) => x.source !== 'OPERATING')
        .every(
          (x: { scope: string; payment_method: null }) =>
            x.scope === 'COMMISSARY' && x.payment_method === null,
        ),
    ).toBe(true);
    expect(
      (await http(manager).get('/expenses?search=Spending%20audit').expect(200))
        .body.total,
    ).toBe(0);
    const detail = await http(commissary)
      .get('/expenses/records/SUPPLIER_DELIVERY/' + supplied.id)
      .expect(200);
    expect(detail.body.history).toEqual([]);
    expect(detail.body.source_href ?? null).toBeNull();
    await http(manager)
      .get('/expenses/records/SUPPLIER_DELIVERY/' + supplied.id)
      .expect(404);
  });

  it('paginates server results while retaining full filtered totals and exports', async () => {
    for (let i = 0; i < 12; i++)
      await http(manager)
        .post('/expenses')
        .send(input({ description: `Pagination expense ${i}`, amount: '0.10' }))
        .expect(201);
    const first = (
      await http(manager)
        .get('/expenses?search=Pagination%20expense&page_size=10')
        .expect(200)
    ).body;
    const second = (
      await http(manager)
        .get('/expenses?search=Pagination%20expense&page_size=10&page=2')
        .expect(200)
    ).body;
    expect(first.total).toBe(12);
    expect(first.items).toHaveLength(10);
    expect(second.items).toHaveLength(2);
    expect(Number(first.summary.recorded_spending)).toBe(1.2);
    expect(second.summary).toEqual(first.summary);
    const csv = await http(manager)
      .get('/expenses/export?search=Pagination%20expense')
      .expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain('Pagination expense 11');
    expect(csv.text).not.toContain('Spending audit supplier');
    await http(manager).get('/expenses/export?scope=COMMISSARY').expect(403);
    await http(manager)
      .get('/expenses?branch_id=' + other)
      .expect(403);
  });

  it('retains assigned inactive branch history and corrections but rejects new entries', async () => {
    const payload = input({
      branch_id: other,
      description: 'Historic Cebu transport',
    });
    const saved = (
      await http(outsider).post('/expenses').send(payload).expect(201)
    ).body.record;
    await db
      .updateTable('branches')
      .set({ status: 'inactive' })
      .where('id', '=', other)
      .execute();
    try {
      const locations = (
        await http(outsider).get('/expenses/locations').expect(200)
      ).body.items;
      expect(locations).toContainEqual(
        expect.objectContaining({ branch_id: other, is_active: false }),
      );
      await http(outsider)
        .get('/expenses/records/OPERATING/' + saved.id)
        .expect(200);
      await http(outsider).post('/expenses').send(payload).expect(400);
      await http(outsider)
        .patch('/expenses/' + saved.id)
        .send({
          ...payload,
          notes: 'Corrected historical note',
          revision: 1,
          reason: 'Documented receipt',
        })
        .expect(200);
      await http(manager)
        .get('/expenses?branch_id=' + other)
        .expect(403);
    } finally {
      await db
        .updateTable('branches')
        .set({ status: 'active' })
        .where('id', '=', other)
        .execute();
    }
  });

  it('rechecks permissions and assignments before retries and moving an expense', async () => {
    const actor = await staff(grants, branch);
    const key = randomUUID();
    const payload = input({ description: 'Revocation coverage' });
    const saved = (
      await http(actor).post('/expenses', key).send(payload).expect(201)
    ).body.record;
    await http(actor)
      .patch('/expenses/' + saved.id)
      .send({
        ...payload,
        branch_id: other,
        revision: 1,
        reason: 'Move outside scope',
      })
      .expect(403);
    await db
      .deleteFrom('coms_auth.branch_users')
      .where('user_id', '=', actor)
      .execute();
    await http(actor).post('/expenses', key).send(payload).expect(403);
    await http(actor)
      .get('/expenses/records/OPERATING/' + saved.id)
      .expect(404);
    await db
      .updateTable('coms_auth.users')
      .set({ role_id: null })
      .where('id', '=', actor)
      .execute();
    await http(actor).get('/expenses').expect(403);
    await http(actor).post('/expenses', key).send(payload).expect(403);
  });

  it('links a historical closed shift without changing its saved cash reconciliation', async () => {
    const movement = await cash('30.25');
    await db
      .updateTable('register_shifts')
      .set({
        status: 'CLOSED',
        closed_at: new Date(),
        closed_by_user_id: manager,
        close_type: 'CASHIER',
        counted_cash: '300',
        left_in_drawer: '100',
        expected_cash: '300',
        cash_difference: '0',
      })
      .where('id', '=', shift)
      .execute();
    const before = await db
      .selectFrom('register_shifts')
      .selectAll()
      .where('id', '=', shift)
      .executeTakeFirstOrThrow();
    const lookups = (
      await http(manager)
        .get('/expenses/cash-outs?branch_id=' + branch)
        .expect(200)
    ).body.items;
    expect(lookups.some((item: { id: string }) => item.id === movement)).toBe(
      true,
    );
    await http(manager)
      .post('/expenses')
      .send(
        input({
          amount: '30.25',
          cash_source: 'REGISTER',
          cash_movement_id: movement,
        }),
      )
      .expect(201);
    expect(
      await db
        .selectFrom('register_shifts')
        .selectAll()
        .where('id', '=', shift)
        .executeTakeFirstOrThrow(),
    ).toEqual(before);
  });

  it('does not expose another location through transferred expense history', async () => {
    const original = input({
      scope: 'COMMISSARY',
      branch_id: null,
      description: 'Private commissary charge',
      notes: 'Private original explanation',
      payee: 'Commissary payee',
    });
    const saved = (await http().post('/expenses').send(original).expect(201))
      .body.record;
    const moved = input({
      branch_id: other,
      description: 'Cebu delivery charge',
      notes: null,
      payee: null,
    });
    await http()
      .patch('/expenses/' + saved.id)
      .send({ ...moved, revision: 1, reason: 'Private transfer explanation' })
      .expect(200);
    const local = (
      await http(outsider)
        .get('/expenses/records/OPERATING/' + saved.id)
        .expect(200)
    ).body;
    expect(local.record.description).toBe('Cebu delivery charge');
    expect(local.history).toEqual([]);
    expect(JSON.stringify(local)).not.toContain('Private');
    await http(outsider)
      .patch('/expenses/' + saved.id)
      .send({
        ...moved,
        notes: 'Cebu note',
        revision: 2,
        reason: 'Cebu receipt clarification',
      })
      .expect(200);
    const localHistory = (
      await http(outsider)
        .get('/expenses/records/OPERATING/' + saved.id)
        .expect(200)
    ).body.history;
    expect(localHistory).toHaveLength(1);
    expect(localHistory[0].reason).toBe('Cebu receipt clarification');
    expect(
      (
        await http()
          .get('/expenses/records/OPERATING/' + saved.id)
          .expect(200)
      ).body.history,
    ).toHaveLength(3);
  });

  it('prevents rollback once expense history exists', async () => {
    await expect(db.transaction().execute((tx) => down(tx))).rejects.toThrow(
      /Keep the additive expenses schema/,
    );
    expect(
      (await http().get('/expenses').expect(200)).body.total,
    ).toBeGreaterThan(0);
  });
});
