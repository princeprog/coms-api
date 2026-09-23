import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as initial from '../src/database/migrations/20260920174538_auth';
import * as rotation from '../src/database/migrations/20260921120000_auth_token_rotation';
import * as limits from '../src/database/migrations/20260922164052_auth_rate_limits';
import * as accessControl from '../src/database/migrations/20260923214210_access_control';
import { PERMISSION_CATALOG } from '../src/modules/access-control/permission-catalog';

describe.skipIf(process.env.COMS_RUN_DB_TESTS !== '1')(
  'access control migration',
  () => {
    const databaseName = `coms_access_test_${randomUUID().replaceAll('-', '')}`;
    const existingUser = {
      email: 'legacy-user@example.com',
      fullName: 'Legacy User',
      contactNumber: 'legacy-user',
      passwordHash: 'existing-password-hash',
    };
    let admin: Pool | undefined;
    let testDb: Kysely<any> | undefined;

    beforeAll(async () => {
      const source =
        process.env.COMS_TEST_ADMIN_URL ??
        parse(readFileSync('.env')).DATABASE_URL;
      const url = new URL(source);
      admin = new Pool({ connectionString: url.toString() });
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      url.pathname = `/${databaseName}`;
      testDb = new Kysely({
        dialect: new PostgresDialect({
          pool: new Pool({ connectionString: url.toString() }),
        }),
      });

      const baseMigrator = new Migrator({
        db: testDb,
        provider: {
          getMigrations: async () => ({ '20260920174538_auth': initial }),
        },
      });
      expect((await baseMigrator.migrateToLatest()).error).toBeUndefined();
      await sql`
        INSERT INTO auth.users (email, full_name, contact_number, hashed_password)
        VALUES (${existingUser.email}, ${existingUser.fullName}, ${existingUser.contactNumber}, ${existingUser.passwordHash})
      `.execute(testDb);

      const migrator = new Migrator({
        db: testDb,
        provider: {
          getMigrations: async () => ({
            '20260920174538_auth': initial,
            '20260921120000_auth_token_rotation': rotation,
            '20260922164052_auth_rate_limits': limits,
            '20260923214210_access_control': accessControl,
          }),
        },
      });
      expect((await migrator.migrateToLatest()).error).toBeUndefined();
    }, 30000);

    afterAll(async () => {
      if (testDb) await testDb.destroy();
      if (admin) {
        await admin.query(
          `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`,
        );
        await admin.end();
      }
    });

    it('creates fixed access catalogs and gives legacy accounts no grants', async () => {
      const roles = await sql<{ code: string; is_system: boolean }>`
        SELECT code, is_system FROM auth.roles ORDER BY code
      `.execute(testDb!);
      expect(roles.rows).toEqual([
        { code: 'NO_ACCESS', is_system: true },
        { code: 'SUPER_ADMIN', is_system: true },
      ]);

      const permissions = await sql<{
        module_key: string;
        action_key: string;
        description: string;
      }>`
        SELECT module_key, action_key, description FROM auth.permissions
        ORDER BY module_key, action_key
      `.execute(testDb!);
      expect(permissions.rows).toEqual(
        [...PERMISSION_CATALOG].sort((left, right) =>
          `${left.module_key}.${left.action_key}`.localeCompare(
            `${right.module_key}.${right.action_key}`,
          ),
        ),
      );

      const tables = await sql<{
        branches: string | null;
        branch_users: string | null;
      }>`
        SELECT to_regclass('public.branches')::text AS branches,
               to_regclass('auth.branch_users')::text AS branch_users
      `.execute(testDb!);
      expect(tables.rows[0]).toEqual({
        branches: 'branches',
        branch_users: 'auth.branch_users',
      });

      const branch = await sql<{ id: string }>`
        INSERT INTO branches (code, branch_name)
        VALUES ('TEST', 'Test Branch')
        RETURNING id
      `.execute(testDb!);
      const userId = await sql<{ id: string }>`
        SELECT id FROM auth.users WHERE email = ${existingUser.email}
      `.execute(testDb!);
      await sql`
        INSERT INTO auth.branch_users (user_id, branch_id)
        VALUES (${userId.rows[0].id}, ${branch.rows[0].id})
      `.execute(testDb!);
      await expect(
        sql`
          INSERT INTO auth.branch_users (user_id, branch_id)
          VALUES (${userId.rows[0].id}, ${branch.rows[0].id})
        `.execute(testDb!),
      ).rejects.toHaveProperty('code', '23505');

      const user = await sql<{
        email: string;
        full_name: string;
        contact_number: string;
        hashed_password: string;
        is_active: boolean;
        role_code: string;
      }>`
        SELECT u.email, u.full_name, u.contact_number, u.hashed_password,
               u.is_active, r.code AS role_code
        FROM auth.users AS u
        JOIN auth.roles AS r ON r.id = u.role_id
        WHERE u.email = ${existingUser.email}
      `.execute(testDb!);
      expect(user.rows).toEqual([
        {
          email: existingUser.email,
          full_name: existingUser.fullName,
          contact_number: existingUser.contactNumber,
          hashed_password: existingUser.passwordHash,
          is_active: true,
          role_code: 'NO_ACCESS',
        },
      ]);

      const roleGrants = await sql<{ count: number }>`
        SELECT count(*)::int AS count FROM auth.role_permissions
      `.execute(testDb!);
      expect(roleGrants.rows[0].count).toBe(0);
    });

    it('rolls back only the added access schema and keeps auth users', async () => {
      await accessControl.down(testDb!);
      const existing = await sql<{ count: number }>`
        SELECT count(*)::int AS count FROM auth.users
        WHERE email = ${existingUser.email} AND hashed_password = ${existingUser.passwordHash}
      `.execute(testDb!);
      expect(existing.rows[0].count).toBe(1);

      const columns = await sql<{ column_name: string }>`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'auth' AND table_name = 'users'
      `.execute(testDb!);
      expect(columns.rows.map(({ column_name }) => column_name)).not.toContain(
        'role_id',
      );
      expect(columns.rows.map(({ column_name }) => column_name)).not.toContain(
        'is_active',
      );
      const removedTables = await sql<{
        branches: string | null;
        roles: string | null;
        permissions: string | null;
        role_permissions: string | null;
        branch_users: string | null;
      }>`
        SELECT to_regclass('public.branches')::text AS branches,
               to_regclass('auth.roles')::text AS roles,
               to_regclass('auth.permissions')::text AS permissions,
               to_regclass('auth.role_permissions')::text AS role_permissions,
               to_regclass('auth.branch_users')::text AS branch_users
      `.execute(testDb!);
      expect(removedTables.rows[0]).toEqual({
        branches: null,
        roles: null,
        permissions: null,
        role_permissions: null,
        branch_users: null,
      });
    });
  },
);
