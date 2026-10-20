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
import { AccessControlService } from '../src/modules/access-control/access-control.service';
import {
  blockingShifts,
  reportShiftSummaries,
} from '../src/modules/shifts/shift-register';
import { testProductCategoryId } from './product-category-fixture';
import { deleteTestShifts } from './shift-fixture';

describe('register shifts and business day (disposable database)', () => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
  let app: INestApplication;
  let db: Kysely<DB>;
  let branchId: string;
  let lateBranchId: string;
  let productId: string;
  let gcashId: string;
  const users: Record<string, string> = {};
  const roleIds: string[] = [];
  const access: Record<
    string,
    { permissions: string[]; superAdmin?: boolean; branches: () => string[] }
  > = {};

  const server = () => app.getHttpServer();
  const get = (user: string, url: string) =>
    request(server()).get(url).set('x-test-user', users[user]);
  const post = (user: string, url: string, body: object, key = randomUUID()) =>
    request(server())
      .post(url)
      .set('x-test-user', users[user])
      .set('Idempotency-Key', key)
      .send(body);
  const shifts = () => `/branches/${branchId}/shifts`;
  const sell = (user: string, payment = 'Cash', branch = branchId) =>
    post(user, `/branches/${branch}/sales`, {
      service_type: 'TAKEAWAY',
      tender_method: payment,
      ...(payment === 'GCash' ? { payment_method_id: gcashId } : {}),
      items: [{ product_id: productId, quantity: '2', price_revision: 1 }],
    });

  beforeAll(async () => {
    if (!process.env.COMS_TEST_DATABASE_NAME?.startsWith('coms_dispatch_test_'))
      throw new Error('Run using scripts/test-disposable-db.cjs');
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
      .overrideProvider(AccessControlService)
      .useValue({
        findAccessContext: async (userId: string) => {
          const name = Object.keys(users).find((key) => users[key] === userId);
          const entry = name ? access[name] : undefined;
          if (!entry) return null;
          return {
            userId,
            accountActive: true,
            role: {
              id: 'test',
              code: entry.superAdmin ? 'SUPER_ADMIN' : 'SHIFT_TEST',
              name: 'Shift test',
              isActive: true,
              isSystem: Boolean(entry.superAdmin),
            },
            permissions: entry.permissions,
            branchIds: entry.branches(),
          };
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

    const makeRole = async (label: string, keys: string[]) => {
      const role = await db
        .insertInto('auth.roles')
        .values({
          code: `SHIFT_${label}_${suffix}`.toUpperCase(),
          role_name: `Shift ${label} ${suffix}`,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      roleIds.push(role.id);
      const permissions = await db
        .selectFrom('auth.permissions')
        .select('id')
        .where(sql<string>`module_key || '.' || action_key`, 'in', keys)
        .execute();
      await db
        .insertInto('auth.role_permissions')
        .values(
          permissions.map(({ id }) => ({
            role_id: role.id,
            permission_id: id,
          })),
        )
        .execute();
      return role.id;
    };
    const cashierKeys = [
      'sales.create',
      'sales.read',
      'sales.void',
      'shifts.read',
      'shifts.operate',
    ];
    const managerKeys = [
      'sales.read',
      'shifts.read',
      'shifts.operate',
      'shifts.review',
    ];
    const cashierRole = await makeRole('cashier', cashierKeys);
    const managerRole = await makeRole('manager', managerKeys);
    const makeUser = async (name: string, roleId: string | null) => {
      users[name] = (
        await db
          .insertInto('auth.users')
          .values({
            email: `shift-${name}-${suffix}@example.invalid`,
            full_name: `Shift ${name}`,
            contact_number: `SH${suffix}${name.slice(0, 4)}`,
            hashed_password: 'not-used',
            role_id: roleId,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    };
    await makeUser('ana', cashierRole);
    await makeUser('ben', cashierRole);
    await makeUser('mia', managerRole);
    await makeUser('viewer', null);
    await makeUser('admin', null);
    branchId = (
      await db
        .insertInto('branches')
        .values({ code: `SH-${suffix}`, branch_name: `Shift branch ${suffix}` })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    lateBranchId = (
      await db
        .insertInto('branches')
        .values({ code: `SL-${suffix}`, branch_name: `Late branch ${suffix}` })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    const both = () => [branchId, lateBranchId];
    access.ana = { permissions: cashierKeys, branches: both };
    access.ben = { permissions: cashierKeys, branches: both };
    access.mia = { permissions: managerKeys, branches: both };
    access.viewer = {
      permissions: ['sales.create', 'shifts.read'],
      branches: both,
    };
    access.admin = { permissions: [], superAdmin: true, branches: () => [] };
    await db
      .insertInto('auth.branch_users')
      .values(
        ['ana', 'ben', 'mia'].flatMap((name) =>
          both().map((branch) => ({ user_id: users[name], branch_id: branch })),
        ),
      )
      .execute();
    productId = (
      await db
        .insertInto('products')
        .values({
          price: '9.25',
          category_id: testProductCategoryId,
          product_name: `Shift meal ${suffix}`,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    await db
      .insertInto('branch_products')
      .values(
        both().map((branch) => ({
          branch_id: branch,
          product_id: productId,
          price: '9.25',
        })),
      )
      .execute();
    gcashId = (
      await db
        .insertInto('payment_methods')
        .values({ name: `GCash ${suffix}`, kind: 'NON_CASH' })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
  }, 30000);

  afterAll(async () => {
    if (db) {
      const branches = [branchId, lateBranchId].filter(Boolean);
      const sales = db
        .selectFrom('sales')
        .select('id')
        .where('branch_id', 'in', branches);
      await db
        .deleteFrom('sale_events')
        .where('sale_id', 'in', sales)
        .execute();
      await db.deleteFrom('sale_items').where('sale_id', 'in', sales).execute();
      await deleteTestShifts(db, branches);
      await db.deleteFrom('sales').where('branch_id', 'in', branches).execute();
      await db
        .deleteFrom('branch_products')
        .where('branch_id', 'in', branches)
        .execute();
      await db
        .deleteFrom('auth.branch_users')
        .where('branch_id', 'in', branches)
        .execute();
      await db.deleteFrom('products').where('id', '=', productId).execute();
      await db
        .deleteFrom('payment_methods')
        .where('id', '=', gcashId)
        .execute();
      await db.deleteFrom('branches').where('id', 'in', branches).execute();
      await db
        .deleteFrom('auth.users')
        .where('id', 'in', Object.values(users))
        .execute();
      await db
        .deleteFrom('auth.role_permissions')
        .where('role_id', 'in', roleIds)
        .execute();
      await db.deleteFrom('auth.roles').where('id', 'in', roleIds).execute();
      await sql`DELETE FROM business_day_rules WHERE effective_from <> '2000-01-01'`.execute(
        db,
      );
    }
    await app?.close();
  });

  it('keeps business days contiguous across a start-time change', async () => {
    await sql`INSERT INTO business_day_rules (effective_from, start_time) VALUES ('2099-01-10', '06:00'), ('2099-01-20', '00:00')`.execute(
      db,
    );
    const result = await sql<Record<string, string>>`
      SELECT
        to_char(coms_business_day_start('2099-01-09') AT TIME ZONE 'Asia/Manila', 'YYYY-MM-DD HH24:MI') AS before_start,
        to_char(coms_business_day_end('2099-01-09') AT TIME ZONE 'Asia/Manila', 'YYYY-MM-DD HH24:MI') AS long_day_end,
        coms_business_date('2099-01-10 05:59+08')::text AS night_shift_date,
        coms_business_date('2099-01-10 06:00+08')::text AS morning_date,
        to_char(coms_business_day_end('2099-01-19') AT TIME ZONE 'Asia/Manila', 'YYYY-MM-DD HH24:MI') AS short_day_end,
        coms_business_date('2099-01-19 23:59+08')::text AS short_day_date,
        coms_business_date('2099-01-20 00:00+08')::text AS after_change
    `.execute(db);
    await sql`DELETE FROM business_day_rules WHERE effective_from >= '2099-01-01'`.execute(
      db,
    );
    expect(result.rows[0]).toEqual({
      before_start: '2099-01-09 00:00',
      long_day_end: '2099-01-10 06:00',
      night_shift_date: '2099-01-09',
      morning_date: '2099-01-10',
      short_day_end: '2099-01-20 00:00',
      short_day_date: '2099-01-19',
      after_change: '2099-01-20',
    });
  });

  it('lets only Super Admin schedule a future business-day start', async () => {
    const current = await get('ana', '/settings/business-day').expect(200);
    expect(current.body.current.start_time).toBe('00:00');
    expect(current.body.scheduled).toBeNull();
    await request(server())
      .put('/settings/business-day')
      .set('x-test-user', users.mia)
      .send({ start_time: '06:00', effective_from: '2099-02-01' })
      .expect(403);
    await request(server())
      .put('/settings/business-day')
      .set('x-test-user', users.admin)
      .send({ start_time: '06:15', effective_from: '2099-02-01' })
      .expect(400);
    await request(server())
      .put('/settings/business-day')
      .set('x-test-user', users.admin)
      .send({
        start_time: '06:00',
        effective_from: current.body.business_today,
      })
      .expect(409);
    const scheduled = await request(server())
      .put('/settings/business-day')
      .set('x-test-user', users.admin)
      .send({ start_time: '06:00', effective_from: '2099-02-01' })
      .expect(200);
    expect(scheduled.body.scheduled).toEqual({
      start_time: '06:00',
      effective_from: '2099-02-01',
    });
    expect(scheduled.body.current.start_time).toBe('00:00');
    const cancelled = await request(server())
      .delete('/settings/business-day/scheduled')
      .set('x-test-user', users.admin)
      .expect(200);
    expect(cancelled.body.scheduled).toBeNull();
  });

  it('runs a blind-counted shift from opening float to manager review', async () => {
    expect((await sell('ana')).body.code).toBe('SHIFT_REQUIRED');
    await post('viewer', shifts(), { opening_float: '100' }).expect(403);

    const [first, second] = await Promise.all([
      post('ana', shifts(), { opening_float: '1000.00' }),
      post('ben', shifts(), { opening_float: '1000.00' }),
    ]);
    expect([first.status, second.status].sort((a, b) => a - b)).toEqual([
      201, 409,
    ]);
    const winner = first.status === 201 ? 'ana' : 'ben';
    const other = winner === 'ana' ? 'ben' : 'ana';
    const shift = (first.status === 201 ? first : second).body;
    expect(shift).toMatchObject({
      shift_number: 1,
      status: 'OPEN',
      expected_opening_float: null,
      cash_hidden: true,
    });

    expect((await sell(other)).body.code).toBe('SHIFT_OWNED_BY_OTHER');
    const cashSale = (await sell(winner).expect(201)).body;
    const refundedLater = (await sell(winner).expect(201)).body;
    await sell(winner, 'GCash').expect(201);
    expect(cashSale).toMatchObject({
      shift_id: shift.id,
      payment_kind: 'CASH',
    });

    const out = { direction: 'OUT', amount: '100', reason: 'Bought ice' };
    const key = randomUUID();
    await post(
      winner,
      `${shifts()}/${shift.id}/cash-movements`,
      out,
      key,
    ).expect(201);
    await post(
      winner,
      `${shifts()}/${shift.id}/cash-movements`,
      out,
      key,
    ).expect(201);
    await post(
      winner,
      `${shifts()}/${shift.id}/cash-movements`,
      { ...out, amount: '90' },
      key,
    ).expect(409);
    await post(winner, `${shifts()}/${shift.id}/cash-movements`, {
      direction: 'IN',
      amount: '50.50',
      reason: 'Change fund',
    }).expect(201);
    await post(winner, `/branches/${branchId}/sales/${cashSale.id}/void`, {
      reason: 'Wrong order',
    }).expect(201);

    const cashierView = (await get(winner, `${shifts()}/current`).expect(200))
      .body.shift;
    expect(cashierView.totals.expected_cash).toBeNull();
    expect(cashierView.totals.sales_count).toBe(3);
    const managerView = (await get('mia', `${shifts()}/current`).expect(200))
      .body.shift;
    // 1000 + 18.5 × 2 cash sales − 18.5 refund − 100 out + 50.50 in
    expect(managerView.totals).toMatchObject({
      expected_cash: '969',
      cash_sales_amount: '37',
      cash_refunds_amount: '18.5',
      non_cash_sales_amount: '18.5',
    });

    await post('mia', `${shifts()}/${shift.id}/close`, {
      counted_cash: '960',
      left_in_drawer: '500',
    }).expect(403);
    await post(winner, `${shifts()}/${shift.id}/close`, {
      counted_cash: '400',
      left_in_drawer: '500',
    }).expect(400);
    const closeKey = randomUUID();
    const closed = (
      await post(
        winner,
        `${shifts()}/${shift.id}/close`,
        { counted_cash: '959.00', left_in_drawer: '500' },
        closeKey,
      ).expect(201)
    ).body;
    expect(closed).toMatchObject({
      status: 'CLOSED',
      expected_cash: '969',
      cash_difference: '-10',
      close_type: 'CASHIER',
    });
    await post(
      winner,
      `${shifts()}/${shift.id}/close`,
      { counted_cash: '959', left_in_drawer: '500' },
      closeKey,
    ).expect(201);
    await post(
      winner,
      `${shifts()}/${shift.id}/close`,
      { counted_cash: '969', left_in_drawer: '500' },
      closeKey,
    ).expect(409);

    const notified = await db
      .selectFrom('notification_recipients as nr')
      .innerJoin('notification_events as ne', 'ne.id', 'nr.event_id')
      .select(['nr.user_id', 'ne.kind'])
      .where('ne.shift_id', '=', shift.id)
      .execute();
    expect(notified).toContainEqual({
      user_id: users.mia,
      kind: 'SHIFT_NEEDS_REVIEW',
    });
    expect(notified.map((row) => row.user_id)).not.toContain(users[winner]);

    expect((await sell(winner)).body.code).toBe('SHIFT_REQUIRED');
    expect(
      (
        await post(
          winner,
          `/branches/${branchId}/sales/${refundedLater.id}/void`,
          { reason: 'Late refund' },
        )
      ).body.code,
    ).toBe('SHIFT_REQUIRED_FOR_REFUND');

    await post(winner, `${shifts()}/${shift.id}/explanation`, {
      explanation: 'Gave extra change',
    }).expect(201);
    await post('mia', `${shifts()}/${shift.id}/review`, {}).expect(400);
    const reviewed = (
      await post('mia', `${shifts()}/${shift.id}/review`, {
        note: 'Counted with cashier',
      }).expect(201)
    ).body;
    expect(reviewed).toMatchObject({
      status: 'REVIEWED',
      cashier_explanation: 'Gave extra change',
      reviewed_by_user_id: users.mia,
    });

    // The next cashier counts the float left behind; a mismatch is flagged for review.
    const next = (
      await post(other, shifts(), { opening_float: '480' }).expect(201)
    ).body;
    expect(next).toMatchObject({
      shift_number: 2,
      expected_opening_float: '500',
      opening_difference: '-20',
    });
    await post(other, `/branches/${branchId}/sales/${refundedLater.id}/void`, {
      reason: 'Late refund',
    }).expect(201);
    const forced = (
      await post('mia', `${shifts()}/${next.id}/force-close`, {
        counted_cash: '461.50',
        left_in_drawer: '461.50',
        reason: 'Cashier left early',
      }).expect(201)
    ).body;
    expect(forced).toMatchObject({
      close_type: 'FORCED',
      expected_cash: '461.5',
      cash_difference: '0',
      closed_by_user_id: users.mia,
    });
    await post('mia', `${shifts()}/${next.id}/review`, {}).expect(400);
    await post('mia', `${shifts()}/${next.id}/review`, {
      note: 'Float short at handover',
    }).expect(201);

    const list = (await get('viewer', `${shifts()}?page_size=10`).expect(200))
      .body;
    expect(
      list.items.map((item: { shift_number: number }) => item.shift_number),
    ).toEqual([2, 1]);
    await get('viewer', `${shifts()}?page_size=20`).expect(400);

    const summaries = await reportShiftSummaries(
      db,
      branchId,
      shift.business_date,
    );
    expect(
      summaries.map((row) => [
        row.shift_number,
        row.status,
        row.cash_difference,
      ]),
    ).toEqual([
      [1, 'REVIEWED', '-10'],
      [2, 'REVIEWED', '0'],
    ]);
    expect(await blockingShifts(db, branchId, shift.business_date)).toEqual({
      open: [],
      unreviewed: [],
    });
  });

  it('blocks a cashier from reviewing their own shift and from selling after the day ends', async () => {
    const yesterday = sql<Date>`coms_business_date(now()) - 1`;
    const late = await db
      .insertInto('register_shifts')
      .values({
        branch_id: lateBranchId,
        business_date: yesterday,
        shift_number: 1,
        opened_by_user_id: users.mia,
        opened_at: sql<Date>`coms_business_day_start(coms_business_date(now()) - 1)`,
        opening_float: '0',
        open_idempotency_key: randomUUID(),
      })
      .returning(['id', sql<string>`business_date::text`.as('business_date')])
      .executeTakeFirstOrThrow();
    access.mia.permissions = [...access.mia.permissions, 'sales.create'];
    expect((await sell('mia', 'Cash', lateBranchId)).body.code).toBe(
      'SHIFT_DAY_ENDED',
    );
    expect(await blockingShifts(db, lateBranchId, late.business_date)).toEqual({
      open: [1],
      unreviewed: [],
    });
    await post('mia', `/branches/${lateBranchId}/shifts/${late.id}/close`, {
      counted_cash: '0',
      left_in_drawer: '0',
    }).expect(201);
    expect(await blockingShifts(db, lateBranchId, late.business_date)).toEqual({
      open: [],
      unreviewed: [1],
    });
    await post(
      'mia',
      `/branches/${lateBranchId}/shifts/${late.id}/review`,
      {},
    ).expect(403);
    await post(
      'admin',
      `/branches/${lateBranchId}/shifts/${late.id}/review`,
      {},
    ).expect(201);
  });
});
