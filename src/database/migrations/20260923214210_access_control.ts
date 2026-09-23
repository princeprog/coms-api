import { sql, type Kysely } from 'kysely';

// `any` is required here since migrations should be frozen in time. alternatively, keep a "snapshot" db interface.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('auth.roles')
    .addColumn('id', 'bigserial', (column) => column.primaryKey())
    .addColumn('code', 'varchar(50)', (column) => column.notNull().unique())
    .addColumn('role_name', 'varchar(120)', (column) =>
      column.notNull().unique(),
    )
    .addColumn('is_system', 'boolean', (column) =>
      column.notNull().defaultTo(false),
    )
    .addColumn('is_active', 'boolean', (column) =>
      column.notNull().defaultTo(true),
    )
    .addColumn('created_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(db.fn('now')),
    )
    .addColumn('updated_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(db.fn('now')),
    )
    .addCheckConstraint(
      'roles_code_uppercase',
      sql`code ~ '^[A-Z][A-Z0-9_]{1,49}$'`,
    )
    .execute();

  await db.schema
    .createTable('auth.permissions')
    .addColumn('id', 'bigserial', (column) => column.primaryKey())
    .addColumn('module_key', 'varchar(64)', (column) => column.notNull())
    .addColumn('action_key', 'varchar(64)', (column) => column.notNull())
    .addColumn('description', 'text', (column) => column.notNull())
    .addUniqueConstraint('permissions_module_action_unique', [
      'module_key',
      'action_key',
    ])
    .addCheckConstraint(
      'permissions_key_format',
      sql`module_key ~ '^[a-z][a-z0-9_]{0,63}$' AND action_key ~ '^[a-z][a-z0-9_]{0,63}$'`,
    )
    .execute();

  await db.schema
    .createTable('auth.role_permissions')
    .addColumn('role_id', 'bigint', (column) =>
      column.notNull().references('auth.roles.id').onDelete('cascade'),
    )
    .addColumn('permission_id', 'bigint', (column) =>
      column.notNull().references('auth.permissions.id').onDelete('cascade'),
    )
    .addColumn('created_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(db.fn('now')),
    )
    .addPrimaryKeyConstraint('role_permissions_pk', [
      'role_id',
      'permission_id',
    ])
    .execute();

  await db.schema
    .createTable('branches')
    .addColumn('id', 'uuid', (column) =>
      column.primaryKey().defaultTo(db.fn('gen_random_uuid')),
    )
    .addColumn('code', 'varchar(50)', (column) => column.notNull().unique())
    .addColumn('branch_name', 'varchar(160)', (column) => column.notNull())
    .addColumn('address', 'text')
    .addColumn('date_opened', 'date')
    .addColumn('status', 'varchar(20)', (column) =>
      column.notNull().defaultTo('active'),
    )
    .addColumn('has_dine_in', 'boolean', (column) =>
      column.notNull().defaultTo(false),
    )
    .addColumn('created_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(db.fn('now')),
    )
    .addColumn('updated_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(db.fn('now')),
    )
    .addCheckConstraint(
      'branches_status_valid',
      sql`status IN ('active', 'inactive')`,
    )
    .execute();

  await db.schema
    .createTable('auth.branch_users')
    .addColumn('id', 'uuid', (column) =>
      column.primaryKey().defaultTo(db.fn('gen_random_uuid')),
    )
    .addColumn('user_id', 'uuid', (column) =>
      column.notNull().references('auth.users.id').onDelete('cascade'),
    )
    .addColumn('branch_id', 'uuid', (column) =>
      column.notNull().references('branches.id').onDelete('cascade'),
    )
    .addColumn('assigned_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(db.fn('now')),
    )
    .addUniqueConstraint('branch_users_user_branch_unique', [
      'user_id',
      'branch_id',
    ])
    .execute();

  await db.schema
    .alterTable('auth.users')
    .addColumn('is_active', 'boolean', (column) =>
      column.notNull().defaultTo(true),
    )
    .addColumn('role_id', 'bigint', (column) =>
      column.references('auth.roles.id').onDelete('restrict'),
    )
    .execute();

  const roles = await db
    .insertInto('auth.roles')
    .values([
      {
        code: 'NO_ACCESS',
        role_name: 'No Access',
        is_system: true,
        is_active: true,
      },
      {
        code: 'SUPER_ADMIN',
        role_name: 'Super Admin',
        is_system: true,
        is_active: true,
      },
    ])
    .returning(['id', 'code'])
    .execute();
  const noAccessRole = roles.find((role) => role.code === 'NO_ACCESS');
  if (!noAccessRole) throw new Error('Failed to create the NO_ACCESS role');
  await db
    .updateTable('auth.users')
    .set({ role_id: noAccessRole.id })
    .where('role_id', 'is', null)
    .execute();
  await db.schema
    .alterTable('auth.users')
    .alterColumn('role_id', (column) => column.setNotNull())
    .execute();

  const permissions = [
    ['roles', 'read', 'View roles and permissions'],
    ['roles', 'create', 'Create roles'],
    ['roles', 'update', 'Update roles'],
    ['roles', 'deactivate', 'Deactivate roles'],
    ['roles', 'permissions_update', 'Change role permission grants'],
    ['staff', 'read', 'View staff accounts'],
    ['staff', 'create', 'Create staff accounts'],
    ['staff', 'update', 'Update staff accounts'],
    ['staff', 'deactivate', 'Deactivate staff accounts'],
    ['staff', 'role_assign', 'Assign roles to staff'],
    ['staff', 'branch_assign', 'Assign staff to branches'],
    ['branches', 'read', 'View branches'],
    ['branches', 'create', 'Create branches'],
    ['branches', 'update', 'Update branches'],
    ['branches', 'deactivate', 'Deactivate branches'],
    ['suppliers', 'read', 'View suppliers'],
    ['suppliers', 'create', 'Create suppliers'],
    ['suppliers', 'update', 'Update suppliers'],
    ['suppliers', 'deactivate', 'Deactivate suppliers'],
    ['stock_items', 'read', 'View stock items'],
    ['stock_items', 'create', 'Create stock items'],
    ['stock_items', 'update', 'Update stock items'],
    ['stock_items', 'deactivate', 'Deactivate stock items'],
    ['inventory', 'read', 'View inventory'],
    ['inventory', 'adjust', 'Adjust inventory with a reason'],
    ['supplier_receipts', 'read', 'View supplier receipts'],
    ['supplier_receipts', 'create', 'Record supplier receipts'],
    ['supplier_receipts', 'post', 'Post supplier receipts to inventory'],
    ['stock_requests', 'read', 'View stock requests'],
    ['stock_requests', 'create', 'Create branch stock requests'],
    ['stock_requests', 'approve', 'Approve stock requests'],
    ['stock_requests', 'reject', 'Reject stock requests'],
    ['stock_requests', 'cancel', 'Cancel own stock requests'],
    ['dispatches', 'read', 'View dispatches'],
    ['dispatches', 'create', 'Prepare dispatches'],
    ['dispatches', 'dispatch', 'Dispatch stock to a branch'],
    ['dispatches', 'receive', 'Record branch dispatch receipts'],
    [
      'dispatches',
      'shortage_close',
      'Close an in-transit shortage with a reason',
    ],
    ['products', 'read', 'View products'],
    ['products', 'create', 'Create products'],
    ['products', 'update', 'Update products'],
    ['products', 'deactivate', 'Deactivate products'],
    ['recipes', 'read', 'View product recipes'],
    ['recipes', 'create', 'Create product recipes'],
    ['recipes', 'update', 'Update product recipes'],
    ['recipes', 'deactivate', 'Deactivate product recipes'],
    ['branch_products', 'read', 'View branch offerings'],
    ['branch_products', 'create', 'Create branch offerings'],
    ['branch_products', 'update', 'Update branch prices and offerings'],
    [
      'branch_products',
      'availability_update',
      'Change branch product availability',
    ],
    ['sales', 'read', 'View sales'],
    ['sales', 'create', 'Record point-of-sale transactions'],
    ['sales', 'void', 'Void sales with a reason'],
    ['daily_reports', 'read', 'View daily reports'],
    ['daily_reports', 'create', 'Create daily reports'],
    ['daily_reports', 'update', 'Update draft daily reports'],
    ['daily_reports', 'submit', 'Submit daily reports for review'],
    ['daily_reports', 'return', 'Return daily reports for correction'],
    ['daily_reports', 'approve', 'Approve daily reports'],
  ] as const;

  await db
    .insertInto('auth.permissions')
    .values(
      permissions.map(([module_key, action_key, description]) => ({
        module_key,
        action_key,
        description,
      })),
    )
    .execute();

  await db.schema
    .createIndex('branch_users_user_id_index')
    .on('auth.branch_users')
    .column('user_id')
    .execute();
  await db.schema
    .createIndex('branch_users_branch_id_index')
    .on('auth.branch_users')
    .column('branch_id')
    .execute();
}

// `any` is required here since migrations should be frozen in time. alternatively, keep a "snapshot" db interface.
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('auth.branch_users').execute();
  await db.schema.dropTable('auth.role_permissions').execute();
  await db.schema.dropTable('auth.permissions').execute();
  await db.schema
    .alterTable('auth.users')
    .dropColumn('role_id')
    .dropColumn('is_active')
    .execute();
  await db.schema.dropTable('auth.roles').execute();
  await db.schema.dropTable('branches').execute();
}
