import type { Kysely } from 'kysely';

const PERMISSIONS = [
  {
    moduleKey: 'dashboard',
    actionKey: 'read',
    description: 'View performance for assigned branches',
  },
  {
    moduleKey: 'dashboard',
    actionKey: 'global_read',
    description: 'View overall and any-branch performance',
  },
  {
    moduleKey: 'dispatches',
    actionKey: 'reconcile',
    description: 'Review dispatch receipt discrepancies and request recounts',
  },
] as const;

type PermissionRow = {
  id: string;
  module_key: string;
  action_key: string;
  description: string;
};
type RoleRow = { id: string; code: string; is_predefined: boolean };

// `any` keeps this migration frozen against the schema version it changes.
export async function up(db: Kysely<any>): Promise<void> {
  const existing = (await db
    .selectFrom('auth.permissions')
    .select(['module_key', 'action_key'])
    .where((eb) =>
      eb.or(
        PERMISSIONS.map(({ moduleKey, actionKey }) =>
          eb.and([
            eb('module_key', '=', moduleKey),
            eb('action_key', '=', actionKey),
          ]),
        ),
      ),
    )
    .execute()) as Array<{ module_key: string; action_key: string }>;
  if (existing.length > 0) {
    throw new Error(
      `Cannot add role-scoped operations because permission keys already exist: ${existing.map(({ module_key, action_key }) => `${module_key}.${action_key}`).join(', ')}.`,
    );
  }

  const inserted = (await db
    .insertInto('auth.permissions')
    .values(
      PERMISSIONS.map(({ moduleKey, actionKey, description }) => ({
        module_key: moduleKey,
        action_key: actionKey,
        description,
      })),
    )
    .returning(['id', 'module_key', 'action_key', 'description'])
    .execute()) as PermissionRow[];
  const permissionByKey = new Map(
    inserted.map((permission) => [
      `${permission.module_key}.${permission.action_key}`,
      permission.id,
    ]),
  );
  const roles = (await db
    .selectFrom('auth.roles')
    .select(['id', 'code', 'is_predefined'])
    .where('code', 'in', ['BRANCH_MANAGER', 'COMMISSARY_MANAGER'])
    .execute()) as RoleRow[];
  const roleByCode = new Map(roles.map((role) => [role.code, role]));

  const branchManager = roleByCode.get('BRANCH_MANAGER');
  if (branchManager?.is_predefined) {
    await db
      .insertInto('auth.role_permissions')
      .values({
        role_id: branchManager.id,
        permission_id: permissionByKey.get('dashboard.read')!,
      })
      .execute();
  }

  const commissaryManager = roleByCode.get('COMMISSARY_MANAGER');
  if (commissaryManager?.is_predefined) {
    const shortageGrant = await db
      .selectFrom('auth.role_permissions as rp')
      .innerJoin('auth.permissions as p', 'p.id', 'rp.permission_id')
      .select('rp.role_id')
      .where('rp.role_id', '=', commissaryManager.id)
      .where('p.module_key', '=', 'dispatches')
      .where('p.action_key', '=', 'shortage_close')
      .executeTakeFirst();
    if (shortageGrant) {
      await db
        .insertInto('auth.role_permissions')
        .values({
          role_id: commissaryManager.id,
          permission_id: permissionByKey.get('dispatches.reconcile')!,
        })
        .execute();
    }
  }
}

export async function down(db: Kysely<any>): Promise<void> {
  const rows = (await db
    .selectFrom('auth.permissions')
    .select(['id', 'module_key', 'action_key', 'description'])
    .where((eb) =>
      eb.or(
        PERMISSIONS.map(({ moduleKey, actionKey }) =>
          eb.and([
            eb('module_key', '=', moduleKey),
            eb('action_key', '=', actionKey),
          ]),
        ),
      ),
    )
    .execute()) as PermissionRow[];
  if (
    rows.length !== PERMISSIONS.length ||
    PERMISSIONS.some((permission) =>
      rows.some(
        (row) =>
          row.module_key === permission.moduleKey &&
          row.action_key === permission.actionKey &&
          row.description !== permission.description,
      ),
    )
  ) {
    throw new Error(
      'Cannot roll back role-scoped operations because the permission catalog has changed.',
    );
  }

  const ids = rows.map(({ id }) => id);
  const grants = (await db
    .selectFrom('auth.role_permissions as rp')
    .innerJoin('auth.roles as r', 'r.id', 'rp.role_id')
    .innerJoin('auth.permissions as p', 'p.id', 'rp.permission_id')
    .select(['r.code', 'r.is_predefined', 'p.module_key', 'p.action_key'])
    .where('rp.permission_id', 'in', ids)
    .execute()) as Array<{
    code: string;
    is_predefined: boolean;
    module_key: string;
    action_key: string;
  }>;
  const unexpectedGrants = grants.filter(
    (grant) =>
      !(
        grant.code === 'BRANCH_MANAGER' &&
        grant.is_predefined &&
        grant.module_key === 'dashboard' &&
        grant.action_key === 'read'
      ) &&
      !(
        grant.code === 'COMMISSARY_MANAGER' &&
        grant.is_predefined &&
        grant.module_key === 'dispatches' &&
        grant.action_key === 'reconcile'
      ),
  );
  if (unexpectedGrants.length > 0) {
    throw new Error(
      `Cannot roll back role-scoped operations because permissions are granted to other roles: ${unexpectedGrants.map(({ code, module_key, action_key }) => `${code} (${module_key}.${action_key})`).join(', ')}.`,
    );
  }

  await db
    .deleteFrom('auth.role_permissions')
    .where('permission_id', 'in', ids)
    .execute();
  await db.deleteFrom('auth.permissions').where('id', 'in', ids).execute();
}
