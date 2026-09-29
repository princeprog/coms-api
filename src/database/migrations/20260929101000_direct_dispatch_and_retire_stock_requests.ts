import { sql, type Kysely } from 'kysely';

const REQUIRED_KEYS = [
  'stock_requests.read',
  'stock_requests.create',
  'stock_requests.approve',
  'stock_requests.reject',
  'stock_requests.cancel',
] as const;

type PermissionRow = {
  module_key: string;
  action_key: string;
  description: string;
  permission_id: string;
};
type GrantRow = {
  role_id: string;
  code: string;
  is_predefined: boolean;
  module_key: string;
  action_key: string;
  description: string;
  permission_id: string;
};

export async function up(db: Kysely<any>): Promise<void> {
  const permissions = (await db
    .selectFrom('auth.permissions')
    .select([
      'id as permission_id',
      'module_key',
      'action_key',
      'description',
    ])
    .where('module_key', '=', 'stock_requests')
    .execute()) as PermissionRow[];
  const keys = permissions
    .map(({ module_key, action_key }) => `${module_key}.${action_key}`)
    .sort();
  if (
    keys.length !== REQUIRED_KEYS.length ||
    REQUIRED_KEYS.some((key) => !keys.includes(key))
  ) {
    throw new Error(
      'Direct dispatch migration blocked: the stock_requests permission catalog differs from the reviewed five-key catalog.',
    );
  }

  const grants = (await db
    .selectFrom('auth.role_permissions as rp')
    .innerJoin('auth.roles as r', 'r.id', 'rp.role_id')
    .innerJoin('auth.permissions as p', 'p.id', 'rp.permission_id')
    .select([
      'rp.role_id',
      'r.code',
      'r.is_predefined',
      'p.module_key',
      'p.action_key',
      'p.description',
      'p.id as permission_id',
    ])
    .where('p.module_key', '=', 'stock_requests')
    .execute()) as GrantRow[];
  const unexpected = grants.filter(
    (grant) =>
      !grant.is_predefined ||
      !['BRANCH_MANAGER', 'COMMISSARY_MANAGER'].includes(grant.code),
  );
  if (unexpected.length > 0) {
    throw new Error(
      `Direct dispatch migration blocked: review legacy stock-request grants for ${unexpected.map((grant) => grant.code).join(', ')} before retiring them.`,
    );
  }

  await db.schema
    .createTable('migration_stock_request_permission_catalog_backup')
    .addColumn('module_key', 'varchar(80)', (column) => column.notNull())
    .addColumn('action_key', 'varchar(80)', (column) => column.notNull())
    .addColumn('description', 'text', (column) => column.notNull())
    .addPrimaryKeyConstraint(
      'migration_stock_request_permission_catalog_backup_pkey',
      ['module_key', 'action_key'],
    )
    .execute();
  await db
    .insertInto('migration_stock_request_permission_catalog_backup')
    .values(
      permissions.map(({ module_key, action_key, description }) => ({
        module_key,
        action_key,
        description,
      })),
    )
    .execute();
  await db.schema
    .createTable('migration_stock_request_permission_grant_backup')
    .addColumn('role_id', 'bigint', (column) => column.notNull())
    .addColumn('module_key', 'varchar(80)', (column) => column.notNull())
    .addColumn('action_key', 'varchar(80)', (column) => column.notNull())
    .addPrimaryKeyConstraint(
      'migration_stock_request_permission_grant_backup_pkey',
      ['role_id', 'module_key', 'action_key'],
    )
    .execute();
  if (grants.length > 0) {
    await db
      .insertInto('migration_stock_request_permission_grant_backup')
      .values(
        grants.map(({ role_id, module_key, action_key }) => ({
          role_id,
          module_key,
          action_key,
        })),
      )
      .execute();
  }

  await db.schema
    .alterTable('dispatch_items')
    .addColumn('stock_item_id', 'uuid', (column) =>
      column.references('stock_items.id').onDelete('restrict'),
    )
    .execute();
  await sql`
    UPDATE dispatch_items AS di
    SET stock_item_id = sri.stock_item_id
    FROM stock_request_items AS sri
    WHERE sri.id = di.stock_request_item_id
  `.execute(db);
  const missingStockItems = await db
    .selectFrom('dispatch_items')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where('stock_item_id', 'is', null)
    .executeTakeFirstOrThrow();
  if (Number(missingStockItems.count) > 0) {
    throw new Error(
      `Direct dispatch migration blocked: ${missingStockItems.count} legacy dispatch line(s) could not be linked to a stock item. Repair these links before retrying.`,
    );
  }
  await db.schema
    .alterTable('dispatch_items')
    .alterColumn('stock_item_id', (column) => column.setNotNull())
    .execute();
  await db.schema
    .alterTable('dispatch_items')
    .alterColumn('stock_request_item_id', (column) => column.dropNotNull())
    .execute();
  await db.schema
    .alterTable('dispatch_items')
    .addUniqueConstraint('dispatch_items_dispatch_stock_item_unique', [
      'dispatch_id',
      'stock_item_id',
    ])
    .execute();
  await db.schema
    .alterTable('dispatches')
    .alterColumn('stock_request_id', (column) => column.dropNotNull())
    .execute();

  const permissionIds = permissions.map(({ permission_id }) => permission_id);
  await db
    .deleteFrom('auth.role_permissions')
    .where('permission_id', 'in', permissionIds)
    .execute();
  await db
    .deleteFrom('auth.permissions')
    .where('id', 'in', permissionIds)
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  const directDispatches = await db
    .selectFrom('dispatches')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where('stock_request_id', 'is', null)
    .executeTakeFirstOrThrow();
  const directItems = await db
    .selectFrom('dispatch_items')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where('stock_request_item_id', 'is', null)
    .executeTakeFirstOrThrow();
  if (Number(directDispatches.count) > 0 || Number(directItems.count) > 0) {
    throw new Error(
      'Cannot roll back direct dispatches while a dispatch or line has no legacy stock-request link. Remove or migrate those dispatch records before retrying; rollback will not invent request history.',
    );
  }

  const recreatedKeys = await db
    .selectFrom('auth.permissions')
    .select(['module_key', 'action_key'])
    .where('module_key', '=', 'stock_requests')
    .execute();
  if (recreatedKeys.length > 0) {
    throw new Error(
      'Cannot roll back direct dispatches because stock-request permission keys were recreated after the migration.',
    );
  }

  const catalog = await db
    .selectFrom('migration_stock_request_permission_catalog_backup')
    .selectAll()
    .execute();
  const grants = await db
    .selectFrom('migration_stock_request_permission_grant_backup')
    .selectAll()
    .execute();
  const roleIds = [...new Set(grants.map(({ role_id }) => role_id))];
  const roles = roleIds.length
    ? await db
        .selectFrom('auth.roles')
        .select(['id', 'code', 'is_predefined'])
        .where('id', 'in', roleIds)
        .execute()
    : [];
  if (
    roles.length !== roleIds.length ||
    roles.some(
      (role) =>
        !role.is_predefined ||
        !['BRANCH_MANAGER', 'COMMISSARY_MANAGER'].includes(role.code),
    )
  ) {
    throw new Error(
      'Cannot roll back direct dispatches because the original predefined stock-request grants cannot be restored safely.',
    );
  }
  if (
    catalog.length !== REQUIRED_KEYS.length ||
    REQUIRED_KEYS.some(
      (key) =>
        !catalog.some(({ module_key, action_key }) => `${module_key}.${action_key}` === key),
    )
  ) {
    throw new Error(
      'Cannot roll back direct dispatches because the stock-request permission backup is incomplete.',
    );
  }

  await db.schema
    .alterTable('dispatches')
    .alterColumn('stock_request_id', (column) => column.setNotNull())
    .execute();
  await db.schema
    .alterTable('dispatch_items')
    .dropConstraint('dispatch_items_dispatch_stock_item_unique')
    .execute();
  await db.schema
    .alterTable('dispatch_items')
    .dropColumn('stock_item_id')
    .execute();
  await db.schema
    .alterTable('dispatch_items')
    .alterColumn('stock_request_item_id', (column) => column.setNotNull())
    .execute();

  const permissions = await db
    .insertInto('auth.permissions')
    .values(
      catalog.map(({ module_key, action_key, description }) => ({
        module_key,
        action_key,
        description,
      })),
    )
    .returning(['id', 'module_key', 'action_key'])
    .execute();
  const permissionByKey = new Map(
    permissions.map((permission) => [
      `${permission.module_key}.${permission.action_key}`,
      permission.id,
    ]),
  );
  if (grants.length > 0) {
    await db
      .insertInto('auth.role_permissions')
      .values(
        grants.map(({ role_id, module_key, action_key }) => ({
          role_id,
          permission_id: permissionByKey.get(`${module_key}.${action_key}`)!,
        })),
      )
      .execute();
  }
  await db.schema
    .dropTable('migration_stock_request_permission_grant_backup')
    .execute();
  await db.schema
    .dropTable('migration_stock_request_permission_catalog_backup')
    .execute();
}
