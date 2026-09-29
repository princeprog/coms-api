import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as initial from '../src/database/migrations/20260920174538_auth';
import * as rotation from '../src/database/migrations/20260921120000_auth_token_rotation';
import * as limits from '../src/database/migrations/20260922164052_auth_rate_limits';
import * as accessControl from '../src/database/migrations/20260923214210_access_control';
import * as predefinedRoles from '../src/database/migrations/20260926011909_predefined_roles';
import * as noAccessRoleRemoval from '../src/database/migrations/20260926032413_remove_no_access_role';
import * as inventoryLocationPermissions from '../src/database/migrations/20260927201942_inventory_location_permissions';
import * as roleScopedOperationPermissions from '../src/database/migrations/20260928223738_role_scoped_operation_permissions';
import { PERMISSION_CATALOG } from '../src/modules/access-control/permission-catalog';
import { RolesRepository } from '../src/modules/roles/roles.repository';

vi.mock('../src/database/database.module', () => ({
  DATABASE: Symbol('DATABASE'),
}));

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
            '20260926032413_remove_no_access_role': noAccessRoleRemoval,
            '20260927201942_inventory_location_permissions':
              inventoryLocationPermissions,
            '20260928223738_role_scoped_operation_permissions':
              roleScopedOperationPermissions,
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
          code: 'SUPER_ADMIN',
          role_name: 'Super Admin',
          is_system: true,
          is_predefined: false,
          is_active: true,
        },
      ]);
      const roleRepository = new RolesRepository(testDb! as never);
      const apiRoles = await roleRepository.list();
      expect(
        apiRoles.every((role) => typeof role.is_predefined === 'boolean'),
      ).toBe(true);
      const cashier = apiRoles.find((role) => role.code === 'CASHIER')!;
      expect(cashier.is_predefined).toBe(true);
      expect(
        await roleRepository.updateName(cashier.id, 'Front Counter'),
      ).toMatchObject({ is_predefined: true });
      await roleRepository.updateName(cashier.id, 'Cashier');
      const customRole = await roleRepository.create({
        code: 'CUSTOM_ROLE',
        role_name: 'Custom Role',
        permission_keys: [],
      });
      expect(customRole.is_predefined).toBe(false);
      await sql`DELETE FROM auth.roles WHERE id = ${customRole.id}`.execute(
        testDb!,
      );
      const permissions = await sql<{
        module_key: string;
        action_key: string;
        description: string;
      }>`
        SELECT module_key, action_key, description FROM auth.permissions
        ORDER BY module_key, action_key
      `.execute(testDb!);
      const catalogBeforeDirectWorkflows = [
        ...PERMISSION_CATALOG.map((permission) =>
          permission.module_key === 'supplier_receipts' &&
          permission.action_key === 'create'
            ? { ...permission, description: 'Record supplier receipts' }
            : permission,
        ),
        {
          module_key: 'supplier_receipts',
          action_key: 'post',
          description: 'Post supplier receipts to inventory',
        },
        {
          module_key: 'stock_requests',
          action_key: 'read',
          description: 'View stock requests',
        },
        {
          module_key: 'stock_requests',
          action_key: 'create',
          description: 'Create branch stock requests',
        },
        {
          module_key: 'stock_requests',
          action_key: 'approve',
          description: 'Approve stock requests',
        },
        {
          module_key: 'stock_requests',
          action_key: 'reject',
          description: 'Reject stock requests',
        },
        {
          module_key: 'stock_requests',
          action_key: 'cancel',
          description: 'Cancel own stock requests',
        },
      ].sort((left, right) =>
          `${left.module_key}.${left.action_key}`.localeCompare(
            `${right.module_key}.${right.action_key}`,
          ),
        );
      expect(permissions.rows).toEqual(catalogBeforeDirectWorkflows);

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
        role_id: string | null;
        role_code: string | null;
      }>`
        SELECT u.email, u.full_name, u.contact_number, u.hashed_password,
               u.is_active, u.role_id, r.code AS role_code
        FROM auth.users AS u
        LEFT JOIN auth.roles AS r ON r.id = u.role_id
        WHERE u.email = ${existingUser.email}
      `.execute(testDb!);
      expect(user.rows).toEqual([
        {
          email: existingUser.email,
          full_name: existingUser.fullName,
          contact_number: existingUser.contactNumber,
          hashed_password: existingUser.passwordHash,
          is_active: true,
          role_id: null,
          role_code: null,
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
          'dashboard.read',
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
          'dispatches.reconcile',
          'dispatches.shortage_close',
          'inventory.adjust',
          'inventory.commissary_adjust',
          'inventory.commissary_read',
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

    it('scopes inventory grants without widening branch or custom roles', async () => {
      const scopedGrants = await sql<{ code: string; action_key: string }>`
        SELECT r.code, p.action_key
        FROM auth.role_permissions AS rp
        JOIN auth.roles AS r ON r.id = rp.role_id
        JOIN auth.permissions AS p ON p.id = rp.permission_id
        WHERE p.module_key = 'inventory'
          AND p.action_key IN ('commissary_read', 'commissary_adjust')
        ORDER BY r.code, p.action_key
      `.execute(testDb!);
      expect(scopedGrants.rows).toEqual([
        { code: 'COMMISSARY_MANAGER', action_key: 'commissary_adjust' },
        { code: 'COMMISSARY_MANAGER', action_key: 'commissary_read' },
      ]);

      await sql`
        INSERT INTO auth.role_permissions (role_id, permission_id)
        SELECT r.id, p.id
        FROM auth.roles AS r
        CROSS JOIN auth.permissions AS p
        WHERE r.code = 'CASHIER'
          AND p.module_key = 'inventory'
          AND p.action_key = 'commissary_read'
      `.execute(testDb!);
      await expect(
        testDb!
          .transaction()
          .execute((trx) => inventoryLocationPermissions.down(trx)),
      ).rejects.toThrow(/other roles.*CASHIER.*commissary_read/i);
      await sql`
        DELETE FROM auth.role_permissions AS rp
        USING auth.roles AS r, auth.permissions AS p
        WHERE rp.role_id = r.id AND rp.permission_id = p.id
          AND r.code = 'CASHIER'
          AND p.module_key = 'inventory'
          AND p.action_key = 'commissary_read'
      `.execute(testDb!);

      await testDb!
        .transaction()
        .execute((trx) => inventoryLocationPermissions.down(trx));
      await sql`
        DELETE FROM auth.role_permissions AS rp
        USING auth.roles AS r, auth.permissions AS p
        WHERE rp.role_id = r.id AND rp.permission_id = p.id
          AND r.code = 'COMMISSARY_MANAGER'
          AND p.module_key = 'inventory' AND p.action_key = 'adjust'
      `.execute(testDb!);
      await testDb!
        .transaction()
        .execute((trx) => inventoryLocationPermissions.up(trx));

      const conditionalGrants = await sql<{ action_key: string }>`
        SELECT p.action_key
        FROM auth.role_permissions AS rp
        JOIN auth.roles AS r ON r.id = rp.role_id
        JOIN auth.permissions AS p ON p.id = rp.permission_id
        WHERE r.code = 'COMMISSARY_MANAGER'
          AND p.module_key = 'inventory'
          AND p.action_key IN ('commissary_read', 'commissary_adjust')
        ORDER BY p.action_key
      `.execute(testDb!);
      expect(conditionalGrants.rows).toEqual([
        { action_key: 'commissary_read' },
      ]);

      await testDb!
        .transaction()
        .execute((trx) => inventoryLocationPermissions.down(trx));
      await sql`
        INSERT INTO auth.role_permissions (role_id, permission_id)
        SELECT r.id, p.id
        FROM auth.roles AS r
        CROSS JOIN auth.permissions AS p
        WHERE r.code = 'COMMISSARY_MANAGER'
          AND p.module_key = 'inventory' AND p.action_key = 'adjust'
      `.execute(testDb!);
      await testDb!
        .transaction()
        .execute((trx) => inventoryLocationPermissions.up(trx));
    });

    it('grants role-scoped access conditionally and guards rollback', async () => {
      const grants = await sql<{ code: string; key: string }>`
        SELECT r.code, p.module_key || '.' || p.action_key AS key
        FROM auth.role_permissions AS rp
        JOIN auth.roles AS r ON r.id = rp.role_id
        JOIN auth.permissions AS p ON p.id = rp.permission_id
        WHERE p.module_key = 'dashboard' OR p.action_key = 'reconcile'
        ORDER BY r.code, key
      `.execute(testDb!);
      expect(grants.rows).toEqual([
        { code: 'BRANCH_MANAGER', key: 'dashboard.read' },
        { code: 'COMMISSARY_MANAGER', key: 'dispatches.reconcile' },
      ]);

      const customRole = await sql<{ id: string }>`
        INSERT INTO auth.roles (code, role_name)
        VALUES ('CUSTOM_DASHBOARD', 'Custom Dashboard')
        RETURNING id
      `.execute(testDb!);
      await sql`
        INSERT INTO auth.role_permissions (role_id, permission_id)
        SELECT ${customRole.rows[0].id}, id FROM auth.permissions
        WHERE module_key = 'dashboard' AND action_key = 'global_read'
      `.execute(testDb!);
      await expect(
        testDb!.transaction().execute((trx) =>
          roleScopedOperationPermissions.down(trx),
        ),
      ).rejects.toThrow(/CUSTOM_DASHBOARD.*dashboard.global_read/i);
      const permissionAfterRejectedRollback = await sql<{ count: number }>`
        SELECT count(*)::int AS count FROM auth.permissions
        WHERE module_key = 'dashboard' AND action_key = 'global_read'
      `.execute(testDb!);
      expect(permissionAfterRejectedRollback.rows[0].count).toBe(1);
      await sql`DELETE FROM auth.roles WHERE id = ${customRole.rows[0].id}`.execute(
        testDb!,
      );

      await sql`
        DELETE FROM auth.role_permissions AS rp
        USING auth.roles AS r, auth.permissions AS p
        WHERE rp.role_id = r.id AND rp.permission_id = p.id
          AND r.code = 'COMMISSARY_MANAGER'
          AND p.module_key = 'dispatches' AND p.action_key = 'shortage_close'
      `.execute(testDb!);
      await testDb!
        .transaction()
        .execute((trx) => roleScopedOperationPermissions.down(trx));
      await testDb!
        .transaction()
        .execute((trx) => roleScopedOperationPermissions.up(trx));
      const conditionalGrant = await sql<{ count: number }>`
        SELECT count(*)::int AS count
        FROM auth.role_permissions AS rp
        JOIN auth.roles AS r ON r.id = rp.role_id
        JOIN auth.permissions AS p ON p.id = rp.permission_id
        WHERE r.code = 'COMMISSARY_MANAGER'
          AND p.module_key = 'dispatches' AND p.action_key = 'reconcile'
      `.execute(testDb!);
      expect(conditionalGrant.rows[0].count).toBe(0);

      await sql`
        INSERT INTO auth.role_permissions (role_id, permission_id)
        SELECT r.id, p.id FROM auth.roles AS r
        CROSS JOIN auth.permissions AS p
        WHERE r.code = 'COMMISSARY_MANAGER'
          AND p.module_key = 'dispatches' AND p.action_key = 'shortage_close'
      `.execute(testDb!);
      await testDb!
        .transaction()
        .execute((trx) => roleScopedOperationPermissions.down(trx));
      await testDb!
        .transaction()
        .execute((trx) => roleScopedOperationPermissions.up(trx));
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
            '20260926032413_remove_no_access_role': noAccessRoleRemoval,
            '20260927201942_inventory_location_permissions':
              inventoryLocationPermissions,
            '20260928223738_role_scoped_operation_permissions':
              roleScopedOperationPermissions,
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

      await testDb!
        .transaction()
        .execute((trx) => roleScopedOperationPermissions.down(trx));
      await testDb!
        .transaction()
        .execute((trx) => inventoryLocationPermissions.down(trx));

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
      await sql`UPDATE auth.users SET role_id = NULL
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

    it('removes NO_ACCESS assignments and restores deny-by-default on rollback', async () => {
      const initialState = await sql<{
        role_id: string | null;
        no_access_count: number;
      }>`
        SELECT u.role_id,
               (SELECT count(*)::int FROM auth.roles WHERE code = 'NO_ACCESS') AS no_access_count
        FROM auth.users AS u WHERE u.email = ${existingUser.email}
      `.execute(testDb!);
      expect(initialState.rows[0]).toEqual({
        role_id: null,
        no_access_count: 0,
      });

      await testDb!
        .transaction()
        .execute((trx) => noAccessRoleRemoval.down(trx));
      const restored = await sql<{
        role_code: string;
        is_nullable: string;
      }>`
        SELECT r.code AS role_code, c.is_nullable
        FROM auth.users AS u
        JOIN auth.roles AS r ON r.id = u.role_id
        JOIN information_schema.columns AS c
          ON c.table_schema = 'auth' AND c.table_name = 'users' AND c.column_name = 'role_id'
        WHERE u.email = ${existingUser.email}
      `.execute(testDb!);
      expect(restored.rows[0]).toEqual({
        role_code: 'NO_ACCESS',
        is_nullable: 'NO',
      });

      await testDb!.transaction().execute((trx) => noAccessRoleRemoval.up(trx));
      const removedAgain = await sql<{ role_id: string | null; count: number }>`
        SELECT u.role_id,
               (SELECT count(*)::int FROM auth.roles WHERE code = 'NO_ACCESS') AS count
        FROM auth.users AS u WHERE u.email = ${existingUser.email}
      `.execute(testDb!);
      expect(removedAgain.rows[0]).toEqual({ role_id: null, count: 0 });
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
