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
import * as predefinedRoles from '../src/database/migrations/20260926011909_predefined_roles';
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
            '20260926011909_predefined_roles': predefinedRoles,
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

    it('creates fixed catalogs and seeds editable operational roles', async () => {
      const roles = await sql<{
        code: string;
        role_name: string;
        is_system: boolean;
        is_predefined: boolean;
        is_active: boolean;
      }>`
        SELECT code, role_name, is_system, is_predefined, is_active
        FROM auth.roles ORDER BY code
      `.execute(testDb!);
      expect(roles.rows).toEqual([
        {
          code: 'BRANCH_MANAGER',
          role_name: 'Branch Manager',
          is_system: false,
          is_predefined: true,
          is_active: true,
        },
        {
          code: 'CASHIER',
          role_name: 'Cashier',
          is_system: false,
          is_predefined: true,
          is_active: true,
        },
        {
          code: 'COMMISSARY_MANAGER',
          role_name: 'Commissary Manager',
          is_system: false,
          is_predefined: true,
          is_active: true,
        },
        {
          code: 'NO_ACCESS',
          role_name: 'No Access',
          is_system: true,
          is_predefined: false,
          is_active: true,
        },
        {
          code: 'SUPER_ADMIN',
          role_name: 'Super Admin',
          is_system: true,
          is_predefined: false,
          is_active: true,
        },
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
        SELECT count(*)::int AS count FROM auth.role_permissions AS rp
        JOIN auth.roles AS r ON r.id = rp.role_id WHERE r.is_system
      `.execute(testDb!);
      expect(roleGrants.rows[0].count).toBe(0);

      const seededGrants = await sql<{ code: string; key: string }>`
        SELECT r.code, p.module_key || '.' || p.action_key AS key
        FROM auth.role_permissions AS rp
        JOIN auth.roles AS r ON r.id = rp.role_id
        JOIN auth.permissions AS p ON p.id = rp.permission_id
        WHERE r.is_predefined
      `.execute(testDb!);
      const grantsByRole = seededGrants.rows.reduce<Record<string, string[]>>(
        (all, { code, key }) => {
          (all[code] ??= []).push(key);
          return all;
        },
        {},
      );
      for (const grants of Object.values(grantsByRole)) grants.sort();
      const expectedGrants = {
        BRANCH_MANAGER: [
          'branch_products.availability_update',
          'branch_products.read',
          'branches.read',
          'daily_reports.create',
          'daily_reports.read',
          'daily_reports.submit',
          'daily_reports.update',
          'dispatches.read',
          'dispatches.receive',
          'inventory.read',
          'products.read',
          'sales.create',
          'sales.read',
          'sales.void',
          'stock_items.read',
          'stock_requests.cancel',
          'stock_requests.create',
          'stock_requests.read',
        ],
        CASHIER: [
          'branch_products.read',
          'branches.read',
          'sales.create',
          'sales.read',
        ],
        COMMISSARY_MANAGER: [
          'branches.read',
          'branch_products.availability_update',
          'branch_products.create',
          'branch_products.read',
          'branch_products.update',
          'daily_reports.approve',
          'daily_reports.read',
          'daily_reports.return',
          'dispatches.create',
          'dispatches.dispatch',
          'dispatches.read',
          'dispatches.shortage_close',
          'inventory.adjust',
          'inventory.read',
          'products.create',
          'products.read',
          'products.update',
          'recipes.create',
          'recipes.read',
          'recipes.update',
          'sales.read',
          'stock_items.create',
          'stock_items.read',
          'stock_items.update',
          'stock_requests.approve',
          'stock_requests.read',
          'stock_requests.reject',
          'supplier_receipts.create',
          'supplier_receipts.post',
          'supplier_receipts.read',
          'suppliers.create',
          'suppliers.read',
          'suppliers.update',
        ],
      };
      for (const grants of Object.values(expectedGrants)) grants.sort();
      expect(grantsByRole).toEqual(expectedGrants);
    });

    it('keeps edited predefined grants and refuses to roll them back', async () => {
      const role = await sql<{ id: string }>`
        SELECT id FROM auth.roles WHERE code = 'CASHIER'
      `.execute(testDb!);
      const originalGrants = await sql<{
        module_key: string;
        action_key: string;
      }>`
        SELECT p.module_key, p.action_key
        FROM auth.role_permissions AS rp
        JOIN auth.permissions AS p ON p.id = rp.permission_id
        WHERE rp.role_id = ${role.rows[0].id}
        ORDER BY p.module_key, p.action_key
      `.execute(testDb!);
      await sql`DELETE FROM auth.role_permissions WHERE role_id = ${role.rows[0].id}`.execute(
        testDb!,
      );

      const migrator = new Migrator({
        db: testDb!,
        provider: {
          getMigrations: async () => ({
            '20260920174538_auth': initial,
            '20260921120000_auth_token_rotation': rotation,
            '20260922164052_auth_rate_limits': limits,
            '20260923214210_access_control': accessControl,
            '20260926011909_predefined_roles': predefinedRoles,
          }),
        },
      });
      const rerun = await migrator.migrateToLatest();
      expect(rerun.error).toBeUndefined();
      const grants = await sql<{ count: number }>`
        SELECT count(*)::int AS count FROM auth.role_permissions
        WHERE role_id = ${role.rows[0].id}
      `.execute(testDb!);
      expect(grants.rows[0].count).toBe(0);

      await expect(predefinedRoles.down(testDb!)).rejects.toThrow(
        /CASHIER.*changed/i,
      );
      const roleAfterRollbackAttempt = await sql<{ is_predefined: boolean }>`
        SELECT is_predefined FROM auth.roles WHERE id = ${role.rows[0].id}
      `.execute(testDb!);
      expect(roleAfterRollbackAttempt.rows[0].is_predefined).toBe(true);

      for (const grant of originalGrants.rows) {
        await sql`
          INSERT INTO auth.role_permissions (role_id, permission_id)
          SELECT ${role.rows[0].id}, id FROM auth.permissions
          WHERE module_key = ${grant.module_key} AND action_key = ${grant.action_key}
        `.execute(testDb!);
      }

      await sql`UPDATE auth.users SET role_id = ${role.rows[0].id}
        WHERE email = ${existingUser.email}`.execute(testDb!);
      await expect(predefinedRoles.down(testDb!)).rejects.toThrow(
        /CASHIER.*assigned/i,
      );
      const noAccess = await sql<{ id: string }>`
        SELECT id FROM auth.roles WHERE code = 'NO_ACCESS'
      `.execute(testDb!);
      await sql`UPDATE auth.users SET role_id = ${noAccess.rows[0].id}
        WHERE email = ${existingUser.email}`.execute(testDb!);
      await predefinedRoles.down(testDb!);

      await sql`
        INSERT INTO auth.roles (code, role_name)
        VALUES ('LOCAL_MANAGER', 'Commissary Manager')
      `.execute(testDb!);
      await expect(
        testDb!.transaction().execute((trx) => predefinedRoles.up(trx)),
      ).rejects.toThrow(/LOCAL_MANAGER.*Commissary Manager/i);
      const columnAfterNameConflict = await sql<{ count: number }>`
        SELECT count(*)::int AS count FROM information_schema.columns
        WHERE table_schema = 'auth' AND table_name = 'roles'
        AND column_name = 'is_predefined'
      `.execute(testDb!);
      expect(columnAfterNameConflict.rows[0].count).toBe(0);
      await sql`DELETE FROM auth.roles WHERE code = 'LOCAL_MANAGER'`.execute(
        testDb!,
      );

      await sql`
        INSERT INTO auth.roles (code, role_name)
        VALUES ('BRANCH_MANAGER', 'Local Branch Manager')
      `.execute(testDb!);
      await expect(
        testDb!.transaction().execute((trx) => predefinedRoles.up(trx)),
      ).rejects.toThrow(/BRANCH_MANAGER.*Local Branch Manager/i);
      await sql`DELETE FROM auth.roles WHERE code = 'BRANCH_MANAGER'`.execute(
        testDb!,
      );

      await sql`DELETE FROM auth.permissions
        WHERE module_key = 'inventory' AND action_key = 'adjust'`.execute(
        testDb!,
      );
      await expect(
        testDb!.transaction().execute((trx) => predefinedRoles.up(trx)),
      ).rejects.toThrow(/missing.*inventory.adjust/i);
      const rolesAfterMissingPermission = await sql<{ count: number }>`
        SELECT count(*)::int AS count FROM auth.roles WHERE code IN
        ('COMMISSARY_MANAGER', 'BRANCH_MANAGER', 'CASHIER')
      `.execute(testDb!);
      expect(rolesAfterMissingPermission.rows[0].count).toBe(0);
      await sql`
        INSERT INTO auth.permissions (module_key, action_key, description)
        VALUES ('inventory', 'adjust', 'Adjust inventory with a reason')
      `.execute(testDb!);
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
