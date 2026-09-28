import type { Kysely } from 'kysely';

const BRANCH_PERMISSIONS = [
  {
    actionKey: 'read',
    description: 'View assigned branch inventory',
    previousDescription: 'View inventory',
    commissaryActionKey: 'commissary_read',
    commissaryDescription: 'View commissary inventory',
  },
  {
    actionKey: 'adjust',
    description: 'Adjust assigned branch inventory with a reason',
    previousDescription: 'Adjust inventory with a reason',
    commissaryActionKey: 'commissary_adjust',
    commissaryDescription: 'Adjust commissary inventory with a reason',
  },
] as const;

type PermissionRow = {
  id: string;
  action_key: string;
  description: string;
};

// `any` is required here since migrations should be frozen in time. alternatively, keep a "snapshot" db interface.
export async function up(db: Kysely<any>): Promise<void> {
  const branchPermissions = (await db
    .selectFrom('auth.permissions')
    .select(['id', 'action_key', 'description'])
    .where('module_key', '=', 'inventory')
    .where(
      'action_key',
      'in',
      BRANCH_PERMISSIONS.map(({ actionKey }) => actionKey),
    )
    .execute()) as PermissionRow[];
  const missingBranchPermissions = BRANCH_PERMISSIONS.filter(
    ({ actionKey }) =>
      !branchPermissions.some(({ action_key }) => action_key === actionKey),
  );
  if (missingBranchPermissions.length > 0) {
    throw new Error(
      `Cannot scope inventory permissions because the catalog is missing: ${missingBranchPermissions.map(({ actionKey }) => `inventory.${actionKey}`).join(', ')}.`,
    );
  }

  const commissaryPermissions = (await db
    .insertInto('auth.permissions')
    .values(
      BRANCH_PERMISSIONS.map(
        ({ commissaryActionKey, commissaryDescription }) => ({
          module_key: 'inventory',
          action_key: commissaryActionKey,
          description: commissaryDescription,
        }),
      ),
    )
    .returning(['id', 'action_key', 'description'])
    .execute()) as PermissionRow[];

  for (const permission of BRANCH_PERMISSIONS) {
    await db
      .updateTable('auth.permissions')
      .set({ description: permission.description })
      .where('module_key', '=', 'inventory')
      .where('action_key', '=', permission.actionKey)
      .execute();
  }

  const commissaryManager = await db
    .selectFrom('auth.roles')
    .select(['id', 'is_predefined'])
    .where('code', '=', 'COMMISSARY_MANAGER')
    .executeTakeFirst();
  if (!commissaryManager?.is_predefined) return;

  for (const permission of BRANCH_PERMISSIONS) {
    const branchPermission = branchPermissions.find(
      ({ action_key }) => action_key === permission.actionKey,
    )!;
    const existingGrant = await db
      .selectFrom('auth.role_permissions')
      .select('role_id')
      .where('role_id', '=', commissaryManager.id)
      .where('permission_id', '=', branchPermission.id)
      .executeTakeFirst();
    if (!existingGrant) continue;

    const commissaryPermission = commissaryPermissions.find(
      ({ action_key }) => action_key === permission.commissaryActionKey,
    )!;
    await db
      .insertInto('auth.role_permissions')
      .values({
        role_id: commissaryManager.id,
        permission_id: commissaryPermission.id,
      })
      .execute();
  }
}

// `any` is required here since migrations should be frozen in time. alternatively, keep a "snapshot" db interface.
export async function down(db: Kysely<any>): Promise<void> {
  const inventoryPermissions = (await db
    .selectFrom('auth.permissions')
    .select(['id', 'action_key', 'description'])
    .where('module_key', '=', 'inventory')
    .where(
      'action_key',
      'in',
      BRANCH_PERMISSIONS.flatMap(({ actionKey, commissaryActionKey }) => [
        actionKey,
        commissaryActionKey,
      ]),
    )
    .execute()) as PermissionRow[];

  for (const permission of BRANCH_PERMISSIONS) {
    const branchPermission = inventoryPermissions.find(
      ({ action_key }) => action_key === permission.actionKey,
    );
    const commissaryPermission = inventoryPermissions.find(
      ({ action_key }) => action_key === permission.commissaryActionKey,
    );
    if (
      !branchPermission ||
      branchPermission.description !== permission.description ||
      !commissaryPermission ||
      commissaryPermission.description !== permission.commissaryDescription
    ) {
      throw new Error(
        'Cannot roll back inventory location permissions because the permission catalog has changed.',
      );
    }
  }

  const commissaryPermissionIds = inventoryPermissions
    .filter(({ action_key }) => action_key.startsWith('commissary_'))
    .map(({ id }) => id);
  const otherRoleGrants = await db
    .selectFrom('auth.role_permissions as rp')
    .innerJoin('auth.roles as r', 'r.id', 'rp.role_id')
    .innerJoin('auth.permissions as p', 'p.id', 'rp.permission_id')
    .select(['r.code', 'p.action_key'])
    .where('rp.permission_id', 'in', commissaryPermissionIds)
    .where((eb) =>
      eb.or([
        eb('r.code', '!=', 'COMMISSARY_MANAGER'),
        eb('r.is_predefined', '=', false),
      ]),
    )
    .execute();
  if (otherRoleGrants.length > 0) {
    throw new Error(
      `Cannot roll back inventory location permissions because they are granted to other roles: ${otherRoleGrants.map(({ code, action_key }: { code: string; action_key: string }) => `${code} (inventory.${action_key})`).join(', ')}.`,
    );
  }

  await db
    .deleteFrom('auth.role_permissions')
    .where('permission_id', 'in', commissaryPermissionIds)
    .execute();
  await db
    .deleteFrom('auth.permissions')
    .where('id', 'in', commissaryPermissionIds)
    .execute();

  for (const permission of BRANCH_PERMISSIONS) {
    await db
      .updateTable('auth.permissions')
      .set({ description: permission.previousDescription })
      .where('module_key', '=', 'inventory')
      .where('action_key', '=', permission.actionKey)
      .execute();
  }
}
