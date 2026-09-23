import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parse } from 'dotenv';
import { Pool } from 'pg';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { DB } from '../src/database/db';
import * as initial from '../src/database/migrations/20260920174538_auth';
import * as rotation from '../src/database/migrations/20260921120000_auth_token_rotation';
import * as limits from '../src/database/migrations/20260922164052_auth_rate_limits';
import { AuthRepository } from '../src/modules/auth/auth.repository';
import { AuthRateLimitRepository } from '../src/modules/auth/auth-rate-limit.repository';
import { AuthRateLimitService } from '../src/modules/auth/auth-rate-limit.service';
import { AuthService } from '../src/modules/auth/auth.service';
import { AuthController } from '../src/modules/auth/auth.controller';
import { AuthGatewayGuard } from '../src/common/guards/auth-gateway.guard';
import { AuthOriginGuard } from '../src/common/guards/auth-origin.guard';
import { AuthCapacityGuard } from '../src/common/guards/auth-capacity.guard';
import { AuthGuard } from '../src/common/guards/auth.guard';
import { hashPassword } from '../src/modules/auth/password-hashing';
import { DATABASE } from '../src/database/database.module';

vi.mock('../src/database/database.module', () => ({
  DATABASE: Symbol('TEST_DATABASE'),
}));

// Opt-in: creates and drops only a uniquely named test database, never the source database.
describe.skipIf(process.env.COMS_RUN_DB_TESTS !== '1')(
  'isolated PostgreSQL auth integration',
  () => {
    const name = `coms_auth_test_${randomUUID().replaceAll('-', '')}`;
    let admin: Pool;
    let db: Kysely<DB>;
    let db2: Kysely<DB>;
    let services: AuthService[];
    const apps: INestApplication[] = [];
    const credentials = {
      email: 'auth-test@example.com',
      password: 'isolated integration test password',
    };
    const headers = {
      'X-COMS-Auth-Gateway': process.env.COMS_AUTH_GATEWAY_SECRET!,
      Origin: process.env.WEB_ORIGIN!,
    };
    const jwt = new JwtService();

    beforeAll(async () => {
      const source =
        process.env.COMS_TEST_ADMIN_URL ??
        parse(readFileSync('.env')).DATABASE_URL;
      const url = new URL(source);
      admin = new Pool({ connectionString: url.toString() });
      await admin.query(`CREATE DATABASE "${name}"`);
      url.pathname = `/${name}`;
      db = new Kysely<DB>({
        dialect: new PostgresDialect({
          pool: new Pool({ connectionString: url.toString() }),
        }),
      });
      db2 = new Kysely<DB>({
        dialect: new PostgresDialect({
          pool: new Pool({ connectionString: url.toString() }),
        }),
      });
      const migrator = new Migrator({
        db,
        provider: {
          getMigrations: async () => ({ initial, rotation, zz_limits: limits }),
        },
      });
      expect((await migrator.migrateToLatest()).error).toBeUndefined();
      expect((await migrator.migrateDown()).error).toBeUndefined();
      expect((await migrator.migrateToLatest()).error).toBeUndefined();
      await sql`
        INSERT INTO auth.users (email, full_name, contact_number, hashed_password)
        VALUES (
          ${credentials.email},
          'Auth Test',
          'test-account',
          ${await hashPassword(credentials.password)}
        )
      `.execute(db);
      for (const connection of [db, db2]) {
        const module = await Test.createTestingModule({
          controllers: [AuthController],
          providers: [
            { provide: DATABASE, useValue: connection },
            JwtService,
            AuthRepository,
            AuthRateLimitRepository,
            AuthRateLimitService,
            AuthService,
            AuthGatewayGuard,
            AuthOriginGuard,
            AuthCapacityGuard,
            AuthGuard,
          ],
        }).compile();
        const app = module.createNestApplication();
        app.use(cookieParser());
        app.useGlobalPipes(
          new ValidationPipe({
            whitelist: true,
            forbidNonWhitelisted: true,
            transform: true,
          }),
        );
        await app.init();
        apps.push(app);
      }
      services = apps.map((app) => app.get(AuthService));
    }, 30000);
    beforeEach(async () => {
      await db.deleteFrom('auth.rate_limit_buckets').execute();
      await db.deleteFrom('auth.refresh_tokens').execute();
      await db.deleteFrom('auth.token_families').execute();
    });
    afterAll(async () => {
      for (const app of apps) await app.close();
      if (db) await db.destroy();
      if (db2) await db2.destroy();
      if (admin) {
        await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
        await admin.end();
      }
    });

    it('issues safe users, hashes history, preserves the absolute family expiry, and revokes logout', async () => {
      const first = await services[0].login(credentials);
      expect(
        first.tokens.refreshExpiresAt.getTime() - Date.now(),
      ).toBeGreaterThan(2_591_998_000);
      expect(
        first.tokens.refreshExpiresAt.getTime() - Date.now(),
      ).toBeLessThanOrEqual(2_592_000_000);
      expect(first.user).not.toHaveProperty('hashed_password');
      const next = await services[1].refresh(first.tokens.refreshToken);
      expect(next.tokens.refreshExpiresAt).toEqual(
        first.tokens.refreshExpiresAt,
      );
      expect(
        await services[0].authenticateAccess(first.tokens.accessToken),
      ).not.toBeNull();
      const rows = await db
        .selectFrom('auth.refresh_tokens')
        .selectAll()
        .execute();
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.token_hash.length === 64)).toBe(true);
      expect(rows.filter((row) => row.consumed_at !== null)).toHaveLength(1);
      await services[0].logout(
        next.tokens.accessToken,
        next.tokens.refreshToken,
      );
      expect(
        await services[1].authenticateAccess(next.tokens.accessToken),
      ).toBeNull();
      await expect(
        services[1].refresh(next.tokens.refreshToken),
      ).rejects.toMatchObject({ status: 401 });
    });
    it('allows only one concurrent rotation and commits replay revocation', async () => {
      const first = await services[0].login(credentials);
      const results = await Promise.allSettled(
        services.map((service) => service.refresh(first.tokens.refreshToken)),
      );
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === 'rejected'),
      ).toHaveLength(1);
      const family = await db
        .selectFrom('auth.token_families')
        .selectAll()
        .executeTakeFirstOrThrow();
      expect(family.revoked_at).not.toBeNull();
      expect(
        await services[0].authenticateAccess(first.tokens.accessToken),
      ).toBeNull();
    });
    it('checks consumed-token replay before the successful family rate limit', async () => {
      const first = await services[0].login(credentials);
      let token = first.tokens.refreshToken;
      for (let i = 0; i < 20; i++)
        token = (await services[i % 2].refresh(token)).tokens.refreshToken;
      await expect(services[0].refresh(token)).rejects.toMatchObject({
        status: 429,
      });
      const bucket = await db
        .selectFrom('auth.rate_limit_buckets')
        .selectAll()
        .where('scope', '=', 'refresh')
        .executeTakeFirstOrThrow();
      expect(bucket.count).toBe(20);
      await expect(
        services[1].refresh(first.tokens.refreshToken),
      ).rejects.toMatchObject({ status: 401 });
      expect(
        await services[0].authenticateAccess(first.tokens.accessToken),
      ).toBeNull();
    });
    it('rejects family expiry and legacy sessions', async () => {
      const first = await services[0].login(credentials);
      await db
        .updateTable('auth.token_families')
        .set({ expires_at: new Date(0) })
        .execute();
      expect(
        await services[1].authenticateAccess(first.tokens.accessToken),
      ).toBeNull();
      await expect(
        services[1].refresh(first.tokens.refreshToken),
      ).rejects.toMatchObject({ status: 401 });
      await request(apps[0].getHttpServer())
        .get('/auth/me')
        .set(headers)
        .set('Cookie', 'coms_session=legacy')
        .expect(401);
    });
    it('exposes no registration and requires gateway plus exact origin', async () => {
      const server = apps[0].getHttpServer();
      await request(server)
        .post('/auth/register')
        .send(credentials)
        .expect(404);
      await request(server).post('/auth/login').send(credentials).expect(403);
      await request(server)
        .post('/auth/login')
        .set('X-COMS-Auth-Gateway', headers['X-COMS-Auth-Gateway'])
        .send(credentials)
        .expect(403);
      await request(server)
        .post('/auth/login')
        .set(headers)
        .set('Origin', 'https://attacker.test')
        .send(credentials)
        .expect(403);
      const login = await request(server)
        .post('/auth/login')
        .set(headers)
        .send(credentials)
        .expect(200);
      const cookies = login.headers['set-cookie'] as unknown as string[];
      expect(cookies).toHaveLength(2);
      expect(
        cookies.every(
          (cookie) =>
            cookie.includes('HttpOnly') && cookie.includes('SameSite=Lax'),
        ),
      ).toBe(true);
      const cookie = cookies.map((value) => value.split(';')[0]).join('; ');
      await request(server)
        .get('/auth/me')
        .set('X-COMS-Auth-Gateway', headers['X-COMS-Auth-Gateway'])
        .set('Cookie', cookie)
        .expect(200);
      const logout = await request(server)
        .post('/auth/logout')
        .set(headers)
        .set('Cookie', cookie)
        .expect(204);
      expect(
        (logout.headers['set-cookie'] as unknown as string[]).every(
          (value) => /Max-Age=0/.test(value) && /HttpOnly/.test(value),
        ),
      ).toBe(true);
    });
    it('shares atomic email limits across two API instances; rejected logins retain counts', async () => {
      const replies = await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          request(apps[i % 2].getHttpServer())
            .post('/auth/login')
            .set(headers)
            .set('X-Forwarded-For', `203.0.113.${i}`)
            .send({
              email:
                i % 2 ? credentials.email : credentials.email.toUpperCase(),
              password: 'wrong',
            }),
        ),
      );
      expect(replies.filter((reply) => reply.status === 401)).toHaveLength(10);
      expect(replies.filter((reply) => reply.status === 429)).toHaveLength(2);
      for (const reply of replies.filter((reply) => reply.status === 429))
        expect(Number(reply.headers['retry-after'])).toBeGreaterThan(0);
      const rows = await db
        .selectFrom('auth.rate_limit_buckets')
        .selectAll()
        .execute();
      expect(rows.find((row) => row.scope === 'login')?.count).toBe(11);
      expect(rows.every((row) => !row.key_hash.includes('@'))).toBe(true);
    });
    it('enforces the independent application ceiling and expires windows using database time', async () => {
      const repositories = [db, db2].map(
        (connection) => new AuthRateLimitRepository(connection),
      );
      const replies = await Promise.all(
        Array.from({ length: 15 }, (_, i) =>
          repositories[i % 2].consume('capacity', 'test-capacity', 10),
        ),
      );
      expect(replies.filter((reply) => reply.allowed)).toHaveLength(10);
      await db
        .updateTable('auth.rate_limit_buckets')
        .set({ reset_at: new Date(0) })
        .execute();
      expect(
        (await repositories[0].consume('capacity', 'test-capacity', 10))
          .allowed,
      ).toBe(true);
    });
    it('revokes a successor after a lost refresh response is replayed', async () => {
      const first = await services[0].login(credentials);
      const lost = await services[1].refresh(first.tokens.refreshToken);
      await expect(
        services[0].refresh(first.tokens.refreshToken),
      ).rejects.toMatchObject({ status: 401 });
      expect(
        await services[1].authenticateAccess(lost.tokens.accessToken),
      ).toBeNull();
      expect(jwt.decode(lost.tokens.refreshToken)).toHaveProperty('exp');
    });
    it('bounds cleanup and preserves live windows', async () => {
      await db
        .insertInto('auth.rate_limit_buckets')
        .values(
          Array.from({ length: 120 }, (_, i) => ({
            scope: 'login',
            key_hash: String(i).padStart(64, '0'),
            count: 1,
            reset_at: new Date(0),
          })),
        )
        .execute();
      const repository = new AuthRateLimitRepository(db);
      await repository.consume('capacity', 'live', 600);
      await repository.cleanup();
      const rows = await db
        .selectFrom('auth.rate_limit_buckets')
        .selectAll()
        .execute();
      expect(rows).toHaveLength(21);
      expect(rows.find((row) => row.scope === 'capacity')?.count).toBe(1);
    });
  },
);
