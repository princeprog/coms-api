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

describe('register device notifications (disposable database)', () => {
  const suffix = randomUUID().slice(0, 8);
  const device = randomUUID();
  let app: INestApplication;
  let db: Kysely<DB>;
  let branch: string;
  let otherBranch: string;
  const users: Record<string, string> = {};
  const as = (user: string) => ({
    get: (url: string) =>
      request(app.getHttpServer()).get(url).set('x-test-user', users[user]),
    post: (url: string, body: object) =>
      request(app.getHttpServer())
        .post(url)
        .set('x-test-user', users[user])
        .send(body),
    patch: (url: string, body: object) =>
      request(app.getHttpServer())
        .patch(url)
        .set('x-test-user', users[user])
        .send(body),
  });
  const received = async (user: string, kind: string) =>
    (
      await db
        .selectFrom('notification_recipients as nr')
        .innerJoin('notification_events as ne', 'ne.id', 'nr.event_id')
        .select(sql<number>`count(*)::int`.as('n'))
        .where('nr.user_id', '=', users[user])
        .where('ne.kind', '=', kind)
        .executeTakeFirstOrThrow()
    ).n;

  beforeAll(async () => {
    if (!process.env.COMS_TEST_DATABASE_NAME?.startsWith('coms_dispatch_test_'))
      throw Error('Disposable database required');
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
    const role = async (code: string, keys: string[]) => {
      const id = (
        await db
          .insertInto('coms_auth.roles')
          .values({
            code: `${code}_${suffix}`.toUpperCase(),
            role_name: `${code} ${suffix}`,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      const permissions = await db
        .selectFrom('coms_auth.permissions')
        .select('id')
        .where(sql<string>`module_key || '.' || action_key`, 'in', keys)
        .execute();
      await db
        .insertInto('coms_auth.role_permissions')
        .values(permissions.map((p) => ({ role_id: id, permission_id: p.id })))
        .execute();
      return id;
    };
    const cashierRole = await role('reg_cashier', [
      'sales.create',
      'sales.read',
    ]);
    const managerRole = await role('reg_manager', [
      'pos_offline.devices_manage',
      'pos_offline.review',
    ]);
    const superAdmin = (
      await db
        .selectFrom('coms_auth.roles')
        .select('id')
        .where('code', '=', 'SUPER_ADMIN')
        .executeTakeFirstOrThrow()
    ).id;
    for (const [name, roleId] of [
      ['cashier', cashierRole],
      ['manager', managerRole],
      ['outsider', managerRole],
      ['admin', superAdmin],
    ] as const)
      users[name] = (
        await db
          .insertInto('coms_auth.users')
          .values({
            email: `reg-${name}-${suffix}@example.invalid`,
            full_name: `Register ${name}`,
            contact_number: `RG${suffix}${name.slice(0, 4)}`,
            hashed_password: 'unused',
            role_id: roleId,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    branch = (
      await db
        .insertInto('branches')
        .values({
          code: `RG-${suffix}`,
          branch_name: `Register branch ${suffix}`,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    otherBranch = (
      await db
        .insertInto('branches')
        .values({ code: `RO-${suffix}`, branch_name: `Other branch ${suffix}` })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    await db
      .insertInto('coms_auth.branch_users')
      .values([
        { user_id: users.cashier, branch_id: branch },
        { user_id: users.manager, branch_id: branch },
        { user_id: users.outsider, branch_id: otherBranch },
      ])
      .execute();
  });
  afterAll(async () => {
    await app?.close();
  });

  const devices = () => `/pos-offline/branches/${branch}/devices`;

  it('notifies branch device managers and Super Admin once when a browser requests approval', async () => {
    await as('cashier')
      .post(devices(), { device_id: device, name: 'Front counter' })
      .expect(201);
    await as('cashier')
      .post(devices(), { device_id: device, name: 'Front counter' })
      .expect(201);
    expect(await received('manager', 'REGISTER_DEVICE_REQUESTED')).toBe(1);
    expect(await received('admin', 'REGISTER_DEVICE_REQUESTED')).toBe(1);
    expect(await received('cashier', 'REGISTER_DEVICE_REQUESTED')).toBe(0);
    expect(await received('outsider', 'REGISTER_DEVICE_REQUESTED')).toBe(0);
    const inbox = await as('manager').get('/notifications').expect(200);
    expect(inbox.body.items[0]).toMatchObject({
      kind: 'REGISTER_DEVICE_REQUESTED',
      register_device_name: 'Front counter',
    });
    const filtered = await as('manager')
      .get('/notifications?type=registers')
      .expect(200);
    expect(filtered.body.total).toBe(1);
  });

  it('lets the cashier read only this branch device status', async () => {
    const own = await as('cashier').get(`${devices()}/${device}`).expect(200);
    expect(own.body).toEqual({
      id: device,
      name: 'Front counter',
      status: 'PENDING',
    });
    await as('cashier').get(`${devices()}/${randomUUID()}`).expect(404);
    await as('outsider').get(`${devices()}/${device}`).expect(403);
  });

  it('notifies the requesting cashier once when approved and when revoked', async () => {
    await as('manager')
      .patch(`${devices()}/${device}`, { status: 'APPROVED' })
      .expect(200);
    await as('manager')
      .patch(`${devices()}/${device}`, { status: 'APPROVED' })
      .expect(200);
    expect(await received('cashier', 'REGISTER_DEVICE_APPROVED')).toBe(1);
    expect(await received('manager', 'REGISTER_DEVICE_APPROVED')).toBe(0);
    const status = await as('cashier')
      .get(`${devices()}/${device}`)
      .expect(200);
    expect(status.body.status).toBe('APPROVED');
    const inbox = await as('cashier').get('/notifications').expect(200);
    expect(inbox.body.items[0]).toMatchObject({
      kind: 'REGISTER_DEVICE_APPROVED',
      register_device_name: 'Front counter',
    });
    await as('manager')
      .patch(`${devices()}/${device}`, { name: 'Counter 1' })
      .expect(200);
    expect(await received('cashier', 'REGISTER_DEVICE_APPROVED')).toBe(1);
    await as('manager')
      .patch(`${devices()}/${device}`, { status: 'REVOKED' })
      .expect(200);
    expect(await received('cashier', 'REGISTER_DEVICE_REVOKED')).toBe(1);
  });
});
