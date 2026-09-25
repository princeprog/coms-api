import type { Kysely } from 'kysely';

type StarterRole = {
  code: string;
  role_name: string;
  permission_keys: readonly string[];
};

// Keep this migration's initial grants fixed; later catalog changes must not
// silently change the access installed by an already reviewed migration.
const STARTER_ROLES: readonly StarterRole[] = [
  {
    code: 'COMMISSARY_MANAGER',
    role_name: 'Commissary Manager',
    permission_keys: [
      'branches.read',
      'suppliers.read',
      'suppliers.create',
      'suppliers.update',
      'stock_items.read',
      'stock_items.create',
      'stock_items.update',
      'inventory.read',
      'inventory.adjust',
      'supplier_receipts.read',
      'supplier_receipts.create',
      'supplier_receipts.post',
      'stock_requests.read',
      'stock_requests.approve',
      'stock_requests.reject',
      'dispatches.read',
      'dispatches.create',
      'dispatches.dispatch',
      'dispatches.shortage_close',
      'products.read',
      'products.create',
      'products.update',
      'recipes.read',
      'recipes.create',
      'recipes.update',
      'branch_products.read',
      'branch_products.create',
      'branch_products.update',
      'branch_products.availability_update',
      'sales.read',
      'daily_reports.read',
      'daily_reports.return',
      'daily_reports.approve',
    ],
  },
  {
    code: 'BRANCH_MANAGER',
    role_name: 'Branch Manager',
    permission_keys: [
      'branches.read',
      'stock_items.read',
      'inventory.read',
      'stock_requests.read',
      'stock_requests.create',
      'stock_requests.cancel',
      'dispatches.read',
      'dispatches.receive',
      'products.read',
      'branch_products.read',
      'branch_products.availability_update',
      'sales.read',
      'sales.create',
      'sales.void',
      'daily_reports.read',
      'daily_reports.create',
      'daily_reports.update',
      'daily_reports.submit',
    ],
  },
  {
    code: 'CASHIER',
    role_name: 'Cashier',
    permission_keys: [
      'branches.read',
      'branch_products.read',
      'sales.read',
      'sales.create',
    ],
  },
];

type PermissionRow = { id: string; module_key: string; action_key: string };
type SeededRoleRow = {
  id: string;
  code: string;
  role_name: string;
  is_system: boolean;
  is_active: boolean;
  is_predefined: boolean;
};

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('auth.roles')
    .addColumn('is_predefined', 'boolean', (column) =>
      column.notNull().defaultTo(false),
    )
    .execute();

  const codes = STARTER_ROLES.map(({ code }) => code);
  const names = STARTER_ROLES.map(({ role_name }) => role_name);
  const conflicts = await db
    .selectFrom('auth.roles')
    .select(['code', 'role_name'])
    .where((eb) =>
      eb.or([eb('code', 'in', codes), eb('role_name', 'in', names)]),
    )
    .execute();
  if (conflicts.length > 0) {
    const details = conflicts
      .map(
        ({ code, role_name }: { code: string; role_name: string }) =>
          `${code} (${role_name})`,
      )
      .join(', ');
    throw new Error(
      `Cannot add predefined roles because an existing role uses a starter code or name: ${details}. Resolve the conflict, then retry the migration.`,
    );
  }

  const permissionRows = (await db
    .selectFrom('auth.permissions')
    .select(['id', 'module_key', 'action_key'])
    .execute()) as PermissionRow[];
  const permissionIds = new Map(
    permissionRows.map((permission) => [
      `${permission.module_key}.${permission.action_key}`,
      permission.id,
    ]),
  );
  const missingKeys = STARTER_ROLES.flatMap(({ permission_keys }) =>
    permission_keys.filter((key) => !permissionIds.has(key)),
  );
  if (missingKeys.length > 0) {
    throw new Error(
      `Cannot add predefined roles because the permission catalog is missing: ${[...new Set(missingKeys)].join(', ')}.`,
    );
  }

  for (const starter of STARTER_ROLES) {
    const role = await db
      .insertInto('auth.roles')
      .values({
        code: starter.code,
        role_name: starter.role_name,
        is_system: false,
        is_predefined: true,
        is_active: true,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    await db
      .insertInto('auth.role_permissions')
      .values(
        starter.permission_keys.map((key) => ({
          role_id: role.id,
          permission_id: permissionIds.get(key)!,
        })),
      )
      .execute();
  }
}

export async function down(db: Kysely<any>): Promise<void> {
  const seededCodes = STARTER_ROLES.map(({ code }) => code);
  const roles = (await db
    .selectFrom('auth.roles')
    .select([
      'id',
      'code',
      'role_name',
      'is_system',
      'is_active',
      'is_predefined',
    ])
    .where((eb) =>
      eb.or([eb('code', 'in', seededCodes), eb('is_predefined', '=', true)]),
    )
    .execute()) as SeededRoleRow[];

  const unknownPredefinedRoles = roles.filter(
    (role) => role.is_predefined && !seededCodes.includes(role.code),
  );
  if (unknownPredefinedRoles.length > 0) {
    throw new Error(
      `Cannot roll back predefined-role metadata while other predefined roles exist: ${unknownPredefinedRoles.map(({ code }) => code).join(', ')}.`,
    );
  }

  for (const starter of STARTER_ROLES) {
    const role = roles.find(({ code }) => code === starter.code);
    if (!role) continue;

    if (
      !role.is_predefined ||
      role.role_name !== starter.role_name ||
      role.is_system ||
      !role.is_active
    ) {
      throw new Error(
        `Cannot roll back predefined role ${starter.code}: its identity or status has changed.`,
      );
    }

    const assignments = await db
      .selectFrom('auth.users')
      .select('id')
      .where('role_id', '=', role.id)
      .limit(1)
      .execute();
    if (assignments.length > 0) {
      throw new Error(
        `Cannot roll back predefined role ${starter.code}: staff are still assigned to it.`,
      );
    }

    const grants = await db
      .selectFrom('auth.role_permissions as rp')
      .innerJoin('auth.permissions as p', 'p.id', 'rp.permission_id')
      .select(['p.module_key', 'p.action_key'])
      .where('rp.role_id', '=', role.id)
      .execute();
    const actualKeys = grants
      .map(
        ({
          module_key,
          action_key,
        }: {
          module_key: string;
          action_key: string;
        }) => `${module_key}.${action_key}`,
      )
      .sort();
    const expectedKeys = [...starter.permission_keys].sort();
    if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
      throw new Error(
        `Cannot roll back predefined role ${starter.code}: its permissions have changed.`,
      );
    }
  }

  await db.deleteFrom('auth.roles').where('code', 'in', seededCodes).execute();
  await db.schema
    .alterTable('auth.roles')
    .dropColumn('is_predefined')
    .execute();
}
