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
import { hashPassword } from '../src/modules/auth/password-hashing';

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
        WHERE (module_key, action_key) IN (('staff','read'),('staff','password_reset'))`.execute(
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

      const blocked = await as(cashier).get('/costs/products');
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
        (await as(cashier).get('/costs/products')).body.code,
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
