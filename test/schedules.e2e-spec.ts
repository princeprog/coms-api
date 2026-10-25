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
import { deleteTestShifts } from './shift-fixture';

const hhmm = (minutes: number) =>
  `${String(Math.floor((minutes % 1440) / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
const plusDays = (date: string, days: number) => {
  const day = new Date(`${date}T00:00:00.000Z`);
  day.setUTCDate(day.getUTCDate() + days);
  return day.toISOString().slice(0, 10);
};
const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7];

describe('branch work schedules (disposable database)', () => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
  let app: INestApplication;
  let db: Kysely<DB>;
  const users: Record<string, string> = {};
  const branches: Record<string, string> = {};
  const access: Record<
    string,
    { permissions: string[]; superAdmin?: boolean; branches: string[] }
  > = {};
  let today: string;
  let nextMonday: string;

  const server = () => app.getHttpServer();
  const as = (user: string) => ({
    get: (url: string) =>
      request(server()).get(url).set('x-test-user', users[user]),
    post: (url: string, body: object = {}) =>
      request(server())
        .post(url)
        .set('x-test-user', users[user])
        .set('Idempotency-Key', randomUUID())
        .send(body),
    put: (url: string, body: object) =>
      request(server()).put(url).set('x-test-user', users[user]).send(body),
    patch: (url: string, body: object) =>
      request(server()).patch(url).set('x-test-user', users[user]).send(body),
    delete: (url: string) =>
      request(server()).delete(url).set('x-test-user', users[user]),
  });
  const templates = (branch: string) =>
    `/branches/${branches[branch]}/shift-templates`;
  const schedule = (branch: string) => `/branches/${branches[branch]}/schedule`;
  const createTemplate = async (
    branch: string,
    name: string,
    start: string,
    end: string,
    weekdays = ALL_DAYS,
  ) => {
    const response = await as('mgr').post(templates(branch), {
      name,
      start_time: start,
      end_time: end,
      weekdays,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return response.body as { id: string; revision: number };
  };
  const manilaMinutes = async () =>
    Number(
      (
        await sql<{
          m: number;
        }>`SELECT (extract(hour FROM now() AT TIME ZONE 'Asia/Manila') * 60
          + extract(minute FROM now() AT TIME ZONE 'Asia/Manila'))::int AS m`.execute(
          db,
        )
      ).rows[0]!.m,
    );

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
              code: entry.superAdmin ? 'SUPER_ADMIN' : 'SCHEDULE_TEST',
              name: 'Schedule test',
              isActive: true,
              isSystem: Boolean(entry.superAdmin),
            },
            permissions: entry.permissions,
            branchIds: entry.branches,
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
    for (const name of ['mgr', 'ana', 'ben', 'outsider', 'admin'])
      users[name] = (
        await db
          .insertInto('coms_auth.users')
          .values({
            email: `schedule-${name}-${suffix}@example.invalid`,
            full_name: `Schedule ${name}`,
            contact_number: `SC${suffix}${name.slice(0, 4)}`,
            hashed_password: 'not-used',
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    for (const name of ['A', 'B', 'C', 'D', 'E', 'X'])
      branches[name] = (
        await db
          .insertInto('branches')
          .values({
            code: `SC${name}-${suffix}`,
            branch_name: `Schedule ${name} ${suffix}`,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    const all = ['A', 'B', 'C', 'D', 'E'].map((name) => branches[name]!);
    const operate = ['shifts.read', 'shifts.operate'];
    access.mgr = {
      permissions: [
        ...operate,
        'shifts.review',
        'schedules.read',
        'schedules.manage',
        'dashboard.read',
      ],
      branches: all,
    };
    access.ana = { permissions: operate, branches: all };
    access.ben = { permissions: operate, branches: all };
    access.outsider = {
      permissions: ['schedules.read', 'schedules.manage'],
      branches: [branches.X!],
    };
    access.admin = { permissions: [], superAdmin: true, branches: [] };
    const member = (user: string, names: string[]) =>
      names.map((name) => ({
        user_id: users[user]!,
        branch_id: branches[name]!,
      }));
    await db
      .insertInto('coms_auth.branch_users')
      .values([
        ...member('mgr', ['A', 'B', 'C', 'D', 'E']),
        ...member('ana', ['A', 'B', 'C']),
        ...member('ben', ['A', 'D', 'E']),
        ...member('outsider', ['X']),
      ])
      .execute();
    today = (
      await sql<{
        d: string;
      }>`SELECT coms_business_date(now())::text AS d`.execute(db)
    ).rows[0]!.d;
    const weekday = ((new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
    nextMonday = plusDays(today, 8 - weekday);
  }, 60000);

  afterAll(async () => {
    if (db) {
      const ids = Object.values(branches);
      await deleteTestShifts(db, ids);
      await db
        .deleteFrom('staff_shift_exceptions')
        .where('branch_id', 'in', ids)
        .execute();
      await db
        .deleteFrom('staff_shift_assignments')
        .where('branch_id', 'in', ids)
        .execute();
      await db
        .deleteFrom('branch_shift_templates')
        .where('branch_id', 'in', ids)
        .execute();
      await db
        .deleteFrom('coms_auth.branch_users')
        .where('branch_id', 'in', ids)
        .execute();
    }
    await app?.close();
  });

  it('validates shifts against permissions and the business day', async () => {
    const morning = {
      name: 'Morning',
      start_time: '06:00',
      end_time: '14:00',
      weekdays: [1, 2, 3, 4, 5],
    };
    expect((await as('ana').post(templates('A'), morning)).status).toBe(403);
    expect((await as('outsider').post(templates('A'), morning)).status).toBe(
      403,
    );
    const overnight = await as('mgr').post(templates('A'), {
      ...morning,
      name: 'Night',
      start_time: '22:00',
      end_time: '06:00',
    });
    expect(overnight.status).toBe(400);
    expect(overnight.body.code).toBe('SHIFT_CROSSES_DAY_START');

    const created = await createTemplate(
      'A',
      'Morning',
      '06:00',
      '14:00',
      [1, 2, 3, 4, 5],
    );
    const duplicate = await as('mgr').post(templates('A'), {
      ...morning,
      name: ' morning ',
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe('SHIFT_NAME_TAKEN');
    const stale = await as('mgr').patch(`${templates('A')}/${created.id}`, {
      ...morning,
      revision: created.revision + 5,
    });
    expect(stale.status).toBe(409);
    const updated = await as('mgr').patch(`${templates('A')}/${created.id}`, {
      ...morning,
      name: 'Opening',
      revision: created.revision,
    });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({
      name: 'Opening',
      revision: 2,
      weekdays: [1, 2, 3, 4, 5],
    });

    // A 10:00 business-day start would split the 06:00–14:00 shift.
    const dayChange = await as('admin').put('/settings/business-day', {
      start_time: '10:00',
      effective_from: plusDays(today, 2),
    });
    expect(dayChange.status).toBe(409);
    expect(dayChange.body.code).toBe('SHIFT_TEMPLATES_CROSS_DAY_START');

    const off = await as('mgr').post(
      `${templates('A')}/${created.id}/deactivate`,
    );
    expect(off.body.is_active).toBe(false);
    const list = await as('ana').get(templates('A'));
    expect(list.status).toBe(403);
    expect((await as('mgr').get(templates('A'))).body[0]).toMatchObject({
      is_active: false,
    });
  });

  it('builds the week from patterns and dated exceptions without overlaps', async () => {
    const day = await createTemplate('A', 'Day', '08:00', '16:00');
    const late = await createTemplate('B', 'Late', '12:00', '20:00');
    const weekdaysOnly = await createTemplate(
      'A',
      'Weekday lunch',
      '11:00',
      '13:00',
      [1, 2, 3, 4, 5],
    );

    const pattern = await as('mgr').put(
      `${schedule('A')}/pattern/${users.ana}`,
      {
        assignments: ALL_DAYS.map((weekday) => ({
          template_id: day.id,
          weekday,
        })),
      },
    );
    expect(pattern.status, JSON.stringify(pattern.body)).toBe(200);
    const overlap = await as('mgr').put(
      `${schedule('B')}/pattern/${users.ana}`,
      {
        assignments: [{ template_id: late.id, weekday: 1 }],
      },
    );
    expect(overlap.status).toBe(409);
    expect(overlap.body.code).toBe('SCHEDULE_OVERLAP');
    const wrongDay = await as('mgr').put(
      `${schedule('A')}/pattern/${users.ben}`,
      {
        assignments: [{ template_id: weekdaysOnly.id, weekday: 6 }],
      },
    );
    expect(wrongDay.status).toBe(400);
    const outsider = await as('mgr').put(
      `${schedule('A')}/pattern/${users.outsider}`,
      {
        assignments: [{ template_id: day.id, weekday: 1 }],
      },
    );
    expect(outsider.status).toBe(404);

    const week = async () =>
      (await as('mgr').get(`${schedule('A')}?week=${plusDays(nextMonday, 3)}`))
        .body;
    let body = await week();
    expect(body.week_start).toBe(nextMonday);
    expect(body.days).toHaveLength(7);
    expect(
      body.shifts.filter((s: { user_id: string }) => s.user_id === users.ana),
    ).toHaveLength(7);

    const dayOff = await as('mgr').post(`${schedule('A')}/exceptions`, {
      user_id: users.ana,
      template_id: day.id,
      work_date: nextMonday,
      kind: 'OFF',
      reason: 'Family event',
    });
    expect(dayOff.status, JSON.stringify(dayOff.body)).toBe(201);
    const repeat = await as('mgr').post(`${schedule('A')}/exceptions`, {
      user_id: users.ana,
      template_id: day.id,
      work_date: nextMonday,
      kind: 'OFF',
    });
    expect(repeat.status).toBe(409);
    const extra = await as('mgr').post(`${schedule('A')}/exceptions`, {
      user_id: users.ben,
      template_id: day.id,
      work_date: plusDays(nextMonday, 1),
      kind: 'EXTRA',
    });
    expect(extra.status).toBe(201);
    const already = await as('mgr').post(`${schedule('A')}/exceptions`, {
      user_id: users.ana,
      template_id: day.id,
      work_date: plusDays(nextMonday, 1),
      kind: 'EXTRA',
    });
    expect(already.body.code).toBe('ALREADY_SCHEDULED');
    const past = await as('mgr').post(`${schedule('A')}/exceptions`, {
      user_id: users.ben,
      template_id: day.id,
      work_date: plusDays(today, -1),
      kind: 'EXTRA',
    });
    expect(past.status).toBe(400);

    body = await week();
    expect(body.off).toEqual([
      expect.objectContaining({
        user_id: users.ana,
        work_date: nextMonday,
        reason: 'Family event',
      }),
    ]);
    expect(
      body.shifts.filter((s: { user_id: string }) => s.user_id === users.ana),
    ).toHaveLength(6);
    expect(body.shifts).toContainEqual(
      expect.objectContaining({
        user_id: users.ben,
        source: 'EXTRA',
        work_date: plusDays(nextMonday, 1),
      }),
    );
    expect(
      (await as('mgr').delete(`${schedule('A')}/exceptions/${extra.body.id}`))
        .status,
    ).toBe(200);
    body = await week();
    expect(
      body.shifts.some((s: { user_id: string }) => s.user_id === users.ben),
    ).toBe(false);

    const mine = await as('ana').get('/schedules/mine');
    expect(mine.status).toBe(200);
    expect(mine.body.business_today).toBe(today);
    // Every day for two weeks, minus next Monday's day off.
    expect(mine.body.shifts).toHaveLength(13);
  });

  it('records whether the person opening the register was scheduled', async () => {
    const now = await manilaMinutes();
    const start = Math.floor(now / 30) * 30;
    const current = await createTemplate(
      'D',
      'Now',
      hhmm(start),
      hhmm(start + 30),
    );
    await as('mgr').put(`${schedule('D')}/pattern/${users.ben}`, {
      assignments: ALL_DAYS.map((weekday) => ({
        template_id: current.id,
        weekday,
      })),
    });
    const scheduled = await as('ben').post(`/branches/${branches.D}/shifts`, {
      opening_float: '500',
    });
    expect(scheduled.status, JSON.stringify(scheduled.body)).toBe(201);
    expect(scheduled.body).toMatchObject({
      schedule_status: 'SCHEDULED',
      scheduled_shift_name: 'Now',
    });

    const unscheduled = await as('mgr').post(`/branches/${branches.B}/shifts`, {
      opening_float: '0',
    });
    expect(unscheduled.body.schedule_status).toBe('UNSCHEDULED');
    const noSchedule = await as('ana').post(`/branches/${branches.C}/shifts`, {
      opening_float: '0',
    });
    expect(noSchedule.body).toMatchObject({
      schedule_status: 'NO_SCHEDULE',
      scheduled_shift_name: null,
    });

    // A shift that started at least 15 minutes ago with no register open.
    const expectNotOpened = now >= 30;
    if (expectNotOpened) {
      const from = Math.floor((now - 15) / 30) * 30;
      const until = Math.min(from + 60, 1440);
      const running = await createTemplate(
        'E',
        'Running',
        hhmm(from),
        hhmm(until),
      );
      await as('mgr').put(`${schedule('E')}/pattern/${users.ben}`, {
        assignments: ALL_DAYS.map((weekday) => ({
          template_id: running.id,
          weekday,
        })),
      });
    }
    const dashboard = await as('mgr').get('/dashboard/today');
    expect(dashboard.status).toBe(200);
    const counts = Object.fromEntries(
      dashboard.body.attention.map((item: { key: string; count: number }) => [
        item.key,
        item.count,
      ]),
    );
    expect(counts.register_opened_unscheduled).toBeGreaterThanOrEqual(1);
    if (expectNotOpened)
      expect(counts.register_not_opened).toBeGreaterThanOrEqual(1);
  });

  it('clears a schedule when branch access is removed', async () => {
    const count = async () =>
      Number(
        (
          await db
            .selectFrom('staff_shift_assignments')
            .select((eb) => eb.fn.countAll<number>().as('n'))
            .where('user_id', '=', users.ana!)
            .where('branch_id', '=', branches.A!)
            .executeTakeFirstOrThrow()
        ).n,
      );
    expect(await count()).toBe(7);
    const response = await as('admin').put(`/staff/${users.ana}/branches`, {
      branch_ids: [branches.B, branches.C],
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(await count()).toBe(0);
    expect(
      await db
        .selectFrom('staff_shift_exceptions')
        .select('id')
        .where('user_id', '=', users.ana!)
        .where('branch_id', '=', branches.A!)
        .execute(),
    ).toEqual([]);
  });
});
