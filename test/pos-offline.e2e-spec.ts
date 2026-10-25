import '../src/config/load-env';
import {
  ExecutionContext,
  ValidationPipe,
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
import { testProductCategoryId } from './product-category-fixture';

describe('offline register (disposable database)', () => {
  let app: INestApplication;
  let db: Kysely<DB>;
  let user: string, branch: string, product: string, shift: string;
  const device = randomUUID();
  let prepared: any;
  const endpoint = () => `/pos-offline/branches/${branch}`;
  const post = (url: string, body: object) =>
    request(app.getHttpServer()).post(url).set('x-test-user', user).send(body);
  beforeAll(async () => {
    if (!process.env.COMS_TEST_DATABASE_NAME?.startsWith('coms_dispatch_test_'))
      throw Error('Disposable database required');
    process.env.COMS_OFFLINE_POS_ENABLED = 'true';
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideGuard(AuthGatewayGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(AuthGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          const req = ctx.switchToHttp().getRequest();
          req.user = { id: req.headers['x-test-user'] };
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
    db = app.get(DATABASE);
    const role = await db
      .selectFrom('coms_auth.roles')
      .select('id')
      .where('code', '=', 'SUPER_ADMIN')
      .executeTakeFirstOrThrow();
    user = (
      await db
        .insertInto('coms_auth.users')
        .values({
          email: `offline-${device}@example.invalid`,
          full_name: 'Offline cashier',
          contact_number: device.slice(0, 20),
          hashed_password: 'unused',
          role_id: role.id,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    branch = (
      await db
        .insertInto('branches')
        .values({
          code: `OFF-${device.slice(0, 8)}`,
          branch_name: 'Offline test branch',
          has_dine_in: true,
          has_takeaway: true,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    product = (
      await db
        .insertInto('products')
        .values({
          product_name: 'Offline test meal',
          price: '99.25',
          price_revision: 1,
          category_id: testProductCategoryId,
          service_types: ['DINE_IN', 'TAKEAWAY'],
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    await db
      .insertInto('branch_products')
      .values({
        branch_id: branch,
        product_id: product,
        price: '99.25',
        service_types: ['DINE_IN', 'TAKEAWAY'],
      })
      .execute();
    const opened = await request(app.getHttpServer())
      .post(`/branches/${branch}/shifts`)
      .set('x-test-user', user)
      .set('Idempotency-Key', randomUUID())
      .send({ opening_float: '1000' });
    expect(opened.status).toBe(201);
    shift = opened.body.id;
  });
  afterAll(async () => {
    delete process.env.COMS_OFFLINE_POS_ENABLED;
    await app?.close();
  });
  it('requires approval, prepares immutable menu without exposing recipe costs', async () => {
    expect(
      (
        await post(`${endpoint()}/devices`, {
          device_id: device,
          name: 'Front counter',
        })
      ).status,
    ).toBe(201);
    expect(
      (await post(`${endpoint()}/sessions/prepare`, { device_id: device }))
        .status,
    ).toBe(409);
    const approved = await request(app.getHttpServer())
      .patch(`${endpoint()}/devices/${device}`)
      .set('x-test-user', user)
      .send({ status: 'APPROVED' });
    expect(approved.status).toBe(200);
    const response = await post(`${endpoint()}/sessions/prepare`, {
      device_id: device,
    });
    expect(response.status).toBe(201);
    prepared = response.body;
    expect(prepared.session.shift_id).toBe(shift);
    // The browser rejects any field outside this contract.
    expect(Object.keys(prepared.session).sort()).toEqual([
      'branch_id',
      'business_date',
      'cashier_id',
      'cutoff_at',
      'device_id',
      'id',
      'issued_at',
      'server_time',
      'shift_id',
    ]);
    const day = await db
      .selectFrom('register_shifts')
      .select(sql<string>`to_char(business_date, 'YYYY-MM-DD')`.as('d'))
      .where('id', '=', shift)
      .executeTakeFirstOrThrow();
    expect(prepared.session.business_date).toBe(day.d);
    expect(prepared.snapshot.products[0].sku).toBeNull();
    expect(prepared.snapshot.products[0].price).toBe('99.25');
    expect(prepared.snapshot.products[0]).not.toHaveProperty('recipe');
  });
  const envelope = (sequence: number) => ({
    id: randomUUID(),
    session_id: prepared.session.id,
    device_id: device,
    shift_id: shift,
    sequence,
    snapshot_id: prepared.snapshot.id,
    captured_at: new Date().toISOString(),
    service_type: 'TAKEAWAY',
    items: [
      {
        product_id: product,
        quantity: '2',
        unit_price: '99.25',
        price_revision: 1,
      },
    ],
    cash_tendered: '200',
    total_amount: '198.5',
  });
  it('honors saved prices, retries lost responses once and rejects changed UUID payloads', async () => {
    await db
      .updateTable('products')
      .set({ price: '120', price_revision: 2 })
      .where('id', '=', product)
      .execute();
    const sale = envelope(1),
      path = `${endpoint()}/sessions/${prepared.session.id}/sync`;
    const first = await post(path, { device_id: device, transactions: [sale] });
    expect(first.status).toBe(201);
    expect(first.body.results[0].status).toBe('ACKNOWLEDGED');
    const retry = await post(path, { device_id: device, transactions: [sale] });
    expect(retry.body).toEqual(first.body);
    expect(
      (
        await post(path, {
          device_id: device,
          transactions: [{ ...sale, cash_tendered: '500' }],
        })
      ).status,
    ).toBe(409);
    const rows = await db
      .selectFrom('sales')
      .selectAll()
      .where('shift_id', '=', shift)
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0].total_amount).toBe('198.5');
  });
  it('blocks ordinary cash sales and normal/forced closing until terminal sequence acknowledged', async () => {
    const ordinary = await request(app.getHttpServer())
      .post(`/branches/${branch}/sales`)
      .set('x-test-user', user)
      .set('Idempotency-Key', randomUUID())
      .send({
        service_type: 'TAKEAWAY',
        tender_method: 'Cash',
        items: [{ product_id: product, quantity: '1', price_revision: 2 }],
      });
    expect(ordinary.status).toBe(409);
    for (const route of ['close', 'force-close']) {
      const res = await request(app.getHttpServer())
        .post(`/branches/${branch}/shifts/${shift}/${route}`)
        .set('x-test-user', user)
        .set('Idempotency-Key', randomUUID())
        .send({
          counted_cash: '1198.5',
          left_in_drawer: '1000',
          ...(route === 'force-close' ? { reason: 'Recovery check' } : {}),
        });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('OFFLINE_SYNC_REQUIRED');
    }
    expect(
      (
        await post(`${endpoint()}/sessions/${prepared.session.id}/finalize`, {
          device_id: device,
          final_sequence: 2,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await post(`${endpoint()}/sessions/${prepared.session.id}/finalize`, {
          device_id: device,
          final_sequence: 1,
        })
      ).status,
    ).toBe(201);
    const stored = await db
      .selectFrom('pos_offline_sessions')
      .select('status')
      .where('id', '=', prepared.session.id)
      .executeTakeFirstOrThrow();
    expect(stored.status).toBe('FINALIZED');
  });
  it('keeps existing sessions drainable when new preparation is disabled', async () => {
    const response = await post(`${endpoint()}/sessions/prepare`, {
      device_id: device,
    });
    expect(response.status).toBe(201);
    prepared = response.body;
    process.env.COMS_OFFLINE_POS_ENABLED = 'false';
    expect(
      (await post(`${endpoint()}/sessions/prepare`, { device_id: device }))
        .status,
    ).toBe(409);
    const sale = {
      ...envelope(1),
      items: [
        {
          product_id: product,
          quantity: '1',
          unit_price: '120',
          price_revision: 2,
        },
      ],
      cash_tendered: '120',
      total_amount: '120',
    };
    expect(
      (
        await post(`${endpoint()}/sessions/${prepared.session.id}/sync`, {
          device_id: device,
          transactions: [sale],
        })
      ).body.results[0].status,
    ).toBe('ACKNOWLEDGED');
    process.env.COMS_OFFLINE_POS_ENABLED = 'true';
  });
  it('rejects missing sequences and forged device binding without losing accepted sales', async () => {
    const path = `${endpoint()}/sessions/${prepared.session.id}/sync`;
    expect(
      (await post(path, { device_id: device, transactions: [envelope(3)] }))
        .status,
    ).toBe(409);
    expect(
      (
        await post(path, {
          device_id: randomUUID(),
          transactions: [envelope(2)],
        })
      ).status,
    ).toBe(403);
    expect(
      await db
        .selectFrom('pos_offline_transactions')
        .select('id')
        .where('session_id', '=', prepared.session.id)
        .execute(),
    ).toHaveLength(1);
  });
  it('holds revoked-device sales and permits audited manager recovery with original cashier', async () => {
    await request(app.getHttpServer())
      .patch(`${endpoint()}/devices/${device}`)
      .set('x-test-user', user)
      .send({ status: 'REVOKED' })
      .expect(200);
    const sale = {
      ...envelope(2),
      items: [
        {
          product_id: product,
          quantity: '1',
          unit_price: '120',
          price_revision: 2,
        },
      ],
      cash_tendered: '120',
      total_amount: '120',
    };
    const path = `${endpoint()}/sessions/${prepared.session.id}`;
    const held = await post(`${path}/sync`, {
      device_id: device,
      transactions: [sale],
    });
    expect(held.body.results[0].status).toBe('NEEDS_REVIEW');
    expect(
      (await post(`${path}/finalize`, { device_id: device, final_sequence: 2 }))
        .status,
    ).toBe(409);
    const reviewed = await post(`${path}/review`, {
      transaction_id: sale.id,
      reason: 'Verified original device sales and cash',
    });
    expect(reviewed.status).toBe(201);
    expect(reviewed.body.status).toBe('ACKNOWLEDGED');
    const recorded = await db
      .selectFrom('sales')
      .select('cashier_user_id')
      .where('id', '=', reviewed.body.sale_id)
      .executeTakeFirstOrThrow();
    expect(recorded.cashier_user_id).toBe(user);
    const audit = await db
      .selectFrom('audit_events')
      .select('metadata')
      .where('entity_id', '=', sale.id)
      .where('action', '=', 'pos_offline.sale_recovered')
      .executeTakeFirst();
    expect(audit).toBeDefined();
    const ids = (
      await db
        .selectFrom('pos_offline_transactions')
        .select('id')
        .where('session_id', '=', prepared.session.id)
        .orderBy('sequence')
        .execute()
    ).map((r) => r.id);
    expect(
      (
        await post(`${path}/recover-finalize`, {
          device_id: device,
          final_sequence: 2,
          transaction_ids: [ids[0]],
          reason: 'Recovered register file',
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await post(`${path}/recover-finalize`, {
          device_id: device,
          final_sequence: 2,
          transaction_ids: ids,
          reason: 'Recovered register file',
        })
      ).status,
    ).toBe(201);
    await request(app.getHttpServer())
      .patch(`${endpoint()}/devices/${device}`)
      .set('x-test-user', user)
      .send({ status: 'APPROVED' })
      .expect(200);
  });
  it('holds tampered cash totals without posting any sale and forbids approval', async () => {
    prepared = (
      await post(`${endpoint()}/sessions/prepare`, { device_id: device })
    ).body;
    const sale = {
      ...envelope(1),
      items: [
        {
          product_id: product,
          quantity: '1',
          unit_price: '120',
          price_revision: 2,
        },
      ],
      cash_tendered: '100',
      total_amount: '100',
    };
    const path = `${endpoint()}/sessions/${prepared.session.id}`;
    const response = await post(`${path}/sync`, {
      device_id: device,
      transactions: [sale],
    });
    expect(response.status).toBe(201);
    expect(response.body.results[0].status).toBe('NEEDS_REVIEW');
    expect(
      await db
        .selectFrom('sales')
        .select('id')
        .where('idempotency_key', '=', sale.id)
        .executeTakeFirst(),
    ).toBeUndefined();
    expect(
      (
        await post(`${path}/review`, {
          transaction_id: sale.id,
          reason: 'Cannot approve a changed total',
        })
      ).status,
    ).toBe(409);
    expect(
      (await post(`${path}/finalize`, { device_id: device, final_sequence: 1 }))
        .status,
    ).toBe(409);
    expect(
      (
        await post(`${path}/recover-finalize`, {
          device_id: device,
          final_sequence: 0,
          transaction_ids: [],
          reason: 'No lost device override',
        })
      ).status,
    ).toBe(400);
  });
  it('enforces current password-change and account restrictions on every upload', async () => {
    await db
      .updateTable('coms_auth.users')
      .set({ must_change_password: true })
      .where('id', '=', user)
      .execute();
    const response = await post(
      `${endpoint()}/sessions/${prepared.session.id}/sync`,
      { device_id: device, transactions: [envelope(2)] },
    );
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('PASSWORD_CHANGE_REQUIRED');
    await db
      .updateTable('coms_auth.users')
      .set({ must_change_password: false })
      .where('id', '=', user)
      .execute();
  });
});
