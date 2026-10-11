import { sql, type Kysely } from 'kysely';
const permissions = [
  [
    'branch_products',
    'services_update',
    'Change assigned branch menu service types',
  ],
  ['menu_requests', 'read', 'View assigned branch menu requests'],
  ['menu_requests', 'create', 'Submit assigned branch menu requests'],
  ['menu_requests', 'cancel', 'Cancel your pending menu requests'],
  [
    'menu_requests',
    'review',
    'Review and decide assigned branch menu requests',
  ],
  ['menu_templates', 'read', 'View menu templates'],
  ['menu_templates', 'manage', 'Create and maintain shared menu templates'],
  ['menu_templates', 'apply', 'Apply templates to assigned branch menus'],
] as const;
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE migration_menu_grants (role_id bigint NOT NULL REFERENCES auth.roles(id), permission_id bigint NOT NULL REFERENCES auth.permissions(id), PRIMARY KEY (role_id,permission_id));`.execute(
    db,
  );
  for (const [module_key, action_key, description] of permissions)
    await db
      .insertInto('auth.permissions')
      .values({ module_key, action_key, description })
      .execute();
  const grants: Record<string, string[]> = {
    BRANCH_MANAGER: [
      'branch_products.create',
      'branch_products.services_update',
      'recipes.read',
      'menu_requests.read',
      'menu_requests.create',
      'menu_requests.cancel',
      'menu_templates.read',
      'menu_templates.apply',
    ],
    COMMISSARY_MANAGER: [
      'branch_products.services_update',
      'menu_requests.read',
      'menu_requests.review',
      'menu_templates.read',
      'menu_templates.manage',
      'menu_templates.apply',
    ],
  };
  for (const [code, keys] of Object.entries(grants)) {
    const role = await db
      .selectFrom('auth.roles')
      .select('id')
      .where('code', '=', code)
      .where('is_predefined', '=', true)
      .where('is_active', '=', true)
      .executeTakeFirst();
    if (!role) continue;
    for (const key of keys) {
      const [moduleKey, actionKey] = key.split('.');
      const permission = await db
        .selectFrom('auth.permissions')
        .select('id')
        .where('module_key', '=', moduleKey)
        .where('action_key', '=', actionKey)
        .executeTakeFirstOrThrow();
      const existing = await db
        .selectFrom('auth.role_permissions')
        .select('role_id')
        .where('role_id', '=', role.id)
        .where('permission_id', '=', permission.id)
        .executeTakeFirst();
      if (existing) continue;
      await db
        .insertInto('auth.role_permissions')
        .values({ role_id: role.id, permission_id: permission.id })
        .execute();
      await db
        .insertInto('migration_menu_grants')
        .values({ role_id: role.id, permission_id: permission.id })
        .execute();
    }
  }
}
export async function down(db: Kysely<any>): Promise<void> {
  for (const [moduleKey, actionKey] of permissions) {
    const extra =
      await sql`SELECT 1 FROM auth.role_permissions rp JOIN auth.permissions p ON p.id=rp.permission_id
      WHERE p.module_key=${moduleKey} AND p.action_key=${actionKey}
      AND NOT EXISTS (SELECT 1 FROM migration_menu_grants g WHERE g.role_id=rp.role_id AND g.permission_id=rp.permission_id) LIMIT 1`.execute(
        db,
      );
    if (extra.rows.length)
      throw new Error(
        'Menu permissions were assigned after rollout; refusing to remove administrator grants.',
      );
  }
  await sql`DELETE FROM auth.role_permissions rp USING migration_menu_grants g WHERE rp.role_id=g.role_id AND rp.permission_id=g.permission_id; DROP TABLE migration_menu_grants;`.execute(
    db,
  );
  for (const [moduleKey, actionKey] of permissions)
    await db
      .deleteFrom('auth.permissions')
      .where('module_key', '=', moduleKey)
      .where('action_key', '=', actionKey)
      .execute();
}
