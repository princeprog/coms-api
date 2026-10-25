import '../src/config/load-env';
import {
  ValidationPipe,
  type ExecutionContext,
  type INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { AuthGatewayGuard } from '../src/common/guards/auth-gateway.guard';
import { AuthGuard } from '../src/common/guards/auth.guard';
import { getAuthConfig } from '../src/config/auth.config';
import { DATABASE } from '../src/database/database.module';
import type { DB } from '../src/database/db';
import { AuthService } from '../src/modules/auth/auth.service';
import {
  hashPassword,
  verifyPassword,
} from '../src/modules/auth/password-hashing';

describe.skipIf(process.env.COMS_RUN_DB_TESTS !== '1')(
  'account recovery',
  () => {
    const name = 'coms_recovery_test_' + randomUUID().replaceAll('-', '');
    let admin: Pool;
    let db: Kysely<DB>;
    let app: INestApplication;
    let dbUrl: string;
    let superAdmin: string,
      manager: string,
      cashier: string,
      otherAdmin: string;
    let branch: string;
    const as = (actor: string) => ({
      get: (path: string) =>
        request(app.getHttpServer()).get(path).set('x-test-actor', actor),
      put: (path: string) =>
        request(app.getHttpServer()).put(path).set('x-test-actor', actor),
      post: (path: string) =>
        request(app.getHttpServer())
          .post(path)
          .set('x-test-actor', actor)
          .set('Origin', getAuthConfig().webOrigin),
    });
    const flags = (id: string) =>
      db
        .selectFrom('coms_auth.users')
        .select(['must_change_password', 'password_changed_at'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
    const openFamilies = async (id: string) =>
      Number(
        (
          await db
            .selectFrom('coms_auth.token_families')
            .select((eb) => eb.fn.countAll().as('n'))
            .where('user_id', '=', id)
            .where('revoked_at', 'is', null)
            .executeTakeFirstOrThrow()
        ).n,
      );
    const family = (id: string) =>
      db
        .insertInto('coms_auth.token_families')
        .values({ user_id: id, expires_at: new Date(Date.now() + 3_600_000) })
        .execute();

    beforeAll(async () => {
      const url = new URL(
        process.env.COMS_TEST_ADMIN_URL ?? process.env.DATABASE_URL!,
      );
      if (!['localhost', '127.0.0.1'].includes(url.hostname))
        throw Error('Use a verified loopback target');
      admin = new Pool({ connectionString: url.toString() });
      await admin.query(`CREATE DATABASE "${name}"`);
      url.pathname = '/' + name;
      dbUrl = url.toString();
      db = new Kysely<DB>({
        dialect: new PostgresDialect({
          pool: new Pool({ connectionString: dbUrl }),
        }),
      });
      const migrations: Record<string, unknown> = {};
      for (const file of readdirSync('src/database/migrations')
        .filter((f) => f.endsWith('.ts'))
        .sort())
        migrations[file.slice(0, -3)] = await import(
          '../src/database/migrations/' + file
        );
      const migrated = await new Migrator({
        db,
        provider: { getMigrations: async () => migrations as never },
      }).migrateToLatest();
      if (migrated.error) throw migrated.error;

      const roleId = async (code: string) =>
        (
          await db
            .selectFrom('coms_auth.roles')
            .select('id')
            .where('code', '=', code)
            .executeTakeFirstOrThrow()
        ).id;
      const resetter = (
        await db
          .insertInto('coms_auth.roles')
          .values({ code: 'RESETTER', role_name: 'Resetter' })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      await sql`INSERT INTO coms_auth.role_permissions (role_id, permission_id)
        SELECT ${resetter}, id FROM coms_auth.permissions
        WHERE (module_key, action_key) IN (('staff','read'),('staff','password_reset'),('staff','create'))`.execute(
        db,
      );
      const hash = await hashPassword('original-password-1');
      const user = async (label: string, role: string) =>
        (
          await db
            .insertInto('coms_auth.users')
            .values({
              email: `${label}@recovery.invalid`,
              full_name: label,
              contact_number: 'recovery-' + label,
              hashed_password: hash,
              role_id: role,
            })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;
      superAdmin = await user('super', await roleId('SUPER_ADMIN'));
      otherAdmin = await user('other-super', await roleId('SUPER_ADMIN'));
      manager = await user('manager', resetter);
      cashier = await user('cashier', await roleId('CASHIER'));
      branch = (
        await db
          .insertInto('branches')
          .values({ code: 'RCV-1', branch_name: 'Recovery branch' })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      await db
        .insertInto('coms_auth.branch_users')
        .values([
          { branch_id: branch, user_id: manager },
          { branch_id: branch, user_id: cashier },
          { branch_id: branch, user_id: otherAdmin },
        ])
        .execute();

      const module = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(DATABASE)
        .useValue(db)
        .overrideGuard(AuthGatewayGuard)
        .useValue({ canActivate: () => true })
        .overrideGuard(AuthGuard)
        .useValue({
          canActivate: (ctx: ExecutionContext) => {
            const req = ctx.switchToHttp().getRequest();
            req.user = { id: req.headers['x-test-actor'] };
            return true;
          },
        })
        .compile();
      app = module.createNestApplication();
      app.use(cookieParser());
      app.useGlobalPipes(
        new ValidationPipe({
          whitelist: true,
          forbidNonWhitelisted: true,
          transform: true,
        }),
      );
      await app.init();
    }, 60000);

    afterAll(async () => {
      await app?.close();
      await db?.destroy();
      if (admin) {
        if (!name.startsWith('coms_recovery_test_'))
          throw Error('Unsafe cleanup');
        await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
        await admin.end();
      }
    });

    it('resets a password once, ends sessions and forces a change', async () => {
      await family(cashier);
      const reset = await as(manager).post(
        `/staff/${cashier}/password-reset?branch_id=${branch}`,
      );
      expect(reset.status).toBe(201);
      expect(reset.body.temporary_password).toMatch(/^[A-Za-z2-9]{14}$/);
      expect((await flags(cashier)).must_change_password).toBe(true);
      expect(await openFamilies(cashier)).toBe(0);

      const blocked = await as(cashier).get('/reports/sales');
      expect(blocked.status).toBe(403);
      expect(blocked.body.code).toBe('PASSWORD_CHANGE_REQUIRED');
      expect((await as(cashier).get('/auth/me')).status).toBe(200);

      const wrong = await as(cashier).post('/auth/password').send({
        current_password: 'not-the-password',
        new_password: 'brand-new-password-9',
      });
      expect(wrong.status).toBe(400);
      const same = await as(cashier).post('/auth/password').send({
        current_password: reset.body.temporary_password,
        new_password: reset.body.temporary_password,
      });
      expect(same.status).toBe(400);
      const changed = await as(cashier).post('/auth/password').send({
        current_password: reset.body.temporary_password,
        new_password: 'brand-new-password-9',
      });
      expect(changed.status).toBe(200);
      expect(changed.body.user.must_change_password).toBe(false);
      expect(String(changed.headers['set-cookie'])).toMatch(/coms/i);
      expect((await flags(cashier)).must_change_password).toBe(false);
      expect(await openFamilies(cashier)).toBe(1);
      expect(
        (await as(cashier).get('/reports/sales')).body.code,
      ).toBeUndefined();
    });

    it('protects self-resets and Super Admin accounts', async () => {
      expect(
        (
          await as(manager).post(
            `/staff/${manager}/password-reset?branch_id=${branch}`,
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await as(manager).post(
            `/staff/${otherAdmin}/password-reset?branch_id=${branch}`,
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await as(cashier).post(
            `/staff/${manager}/password-reset?branch_id=${branch}`,
          )
        ).status,
      ).toBe(403);
      expect(
        (await as(superAdmin).post(`/staff/${otherAdmin}/password-reset`))
          .status,
      ).toBe(201);
    });

    it('creates staff with a rotating admin default and gates their first sign-in', async () => {
      const endpoint = '/staff/default-password';
      const firstPassword = 'Synthetic onboarding default 1!';
      const nextPassword = 'Synthetic onboarding default 2!';
      const input = {
        email: 'new-staff@recovery.invalid',
        full_name: 'New Staff',
        contact_number: '09171234567',
        branch_ids: [branch],
      };
      expect((await as(superAdmin).get(endpoint)).body).toEqual({
        configured: false,
        updated_at: null,
      });
      expect((await as(superAdmin).post('/staff').send(input)).status).toBe(
        409,
      );
      expect(
        (await as(manager).put(endpoint).send({ password: firstPassword }))
          .status,
      ).toBe(403);
      expect((await as(manager).get(endpoint)).body.configured).toBe(false);
      expect((await as(cashier).get(endpoint)).status).toBe(403);
      expect(
        (await as(superAdmin).put(endpoint).send({ password: 'short' })).status,
      ).toBe(400);
      const setting = await as(superAdmin)
        .put(endpoint)
        .send({ password: firstPassword });
      expect(setting.status).toBe(200);
      expect(Object.keys(setting.body).sort()).toEqual([
        'configured',
        'updated_at',
      ]);
      expect(setting.body.configured).toBe(true);
      expect(
        (
          await as(superAdmin)
            .post('/staff')
            .send({ ...input, password: firstPassword })
        ).status,
      ).toBe(400);
      const created = await as(manager).post('/staff').send(input);
      expect(created.status).toBe(201);
      expect(created.body).not.toHaveProperty('hashed_password');
      const id = created.body.id;
      expect((await flags(id)).must_change_password).toBe(true);
      const auth = app.get(AuthService);
      const session = await auth.login({
        email: input.email,
        password: firstPassword,
      });
      expect(session.user.must_change_password).toBe(true);
      // Unassigned staff must also be able to finish onboarding.
      expect((await as(id).get('/auth/me')).status).toBe(200);
      for (const path of [
        '/staff',
        '/branches',
        '/reports/sales',
        '/staff/default-password',
      ]) {
        const blocked = await as(id).get(path);
        expect(blocked.status).toBe(403);
        expect(blocked.body.code).toBe('PASSWORD_CHANGE_REQUIRED');
      }
      expect(
        (await as(id).put(endpoint).send({ password: nextPassword })).status,
      ).toBe(403);
      expect(
        (await as(superAdmin).put(endpoint).send({ password: nextPassword }))
          .status,
      ).toBe(200);
      await expect(
        auth.login({ email: input.email, password: firstPassword }),
      ).resolves.toBeTruthy();
      await expect(
        auth.login({ email: input.email, password: nextPassword }),
      ).rejects.toMatchObject({ status: 401 });
      const second = await as(superAdmin)
        .post('/staff')
        .send({
          ...input,
          email: 'second-staff@recovery.invalid',
          contact_number: '09171234568',
        });
      expect(second.status).toBe(201);
      await expect(
        auth.login({
          email: 'second-staff@recovery.invalid',
          password: nextPassword,
        }),
      ).resolves.toMatchObject({ user: { must_change_password: true } });
      expect(
        (
          await as(id).post('/auth/password').send({
            current_password: firstPassword,
            new_password: firstPassword,
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await as(id).post('/auth/password').send({
            current_password: 'incorrect',
            new_password: 'Personal password only 1!',
          })
        ).status,
      ).toBe(400);
      const changed = await as(id).post('/auth/password').send({
        current_password: firstPassword,
        new_password: 'Personal password only 1!',
      });
      expect(changed.status).toBe(200);
      expect(changed.body.user.must_change_password).toBe(false);
      expect(
        await auth.authenticateAccess(session.tokens.accessToken),
      ).toBeNull();
      await expect(
        auth.login({ email: input.email, password: firstPassword }),
      ).rejects.toMatchObject({ status: 401 });
      await expect(
        auth.login({
          email: input.email,
          password: 'Personal password only 1!',
        }),
      ).resolves.toMatchObject({ user: { must_change_password: false } });
      const stored = await db
        .selectFrom('coms_auth.staff_onboarding_settings')
        .selectAll()
        .executeTakeFirstOrThrow();
      expect(stored.hashed_password).not.toBe(nextPassword);
      expect(await verifyPassword(stored.hashed_password, nextPassword)).toBe(
        true,
      );
      const audit = await db
        .selectFrom('audit_events')
        .selectAll()
        .where('action', '=', 'staff.default_password_updated')
        .execute();
      expect(audit).toHaveLength(2);
      const serialized = JSON.stringify(audit);
      expect(serialized).not.toContain(firstPassword);
      expect(serialized).not.toContain(nextPassword);
      expect(serialized).not.toContain(stored.hashed_password);
    });

    it('resets a locked-out account from the command line', () => {
      const run = spawnSync(
        process.execPath,
        [
          'node_modules/ts-node/dist/bin.js',
          '--transpile-only',
          'scripts/reset-password.ts',
          '--email',
          'super@recovery.invalid',
          '--generate',
        ],
        { encoding: 'utf8', env: { ...process.env, DATABASE_URL: dbUrl } },
      );
      expect(run.status).toBe(0);
      expect(run.stdout).toMatch(/Temporary password: [A-Za-z2-9]{14}/);
      return flags(superAdmin).then((row) =>
        expect(row.must_change_password).toBe(true),
      );
    }, 60000);
  },
);
