import type { Kysely } from 'kysely';

// `any` is required here since migrations should be frozen in time. alternatively, keep a "snapshot" db interface.
export async function up(db: Kysely<any>): Promise<void> {
  const role = await db
    .selectFrom('auth.roles')
    .select(['id', 'is_system'])
    .where('code', '=', 'NO_ACCESS')
    .executeTakeFirst();
  if (!role || !role.is_system)
    throw new Error(
      'Expected the protected NO_ACCESS system role before removal',
    );

  await db.schema
    .alterTable('auth.users')
    .alterColumn('role_id', (column: any) => column.dropNotNull())
    .execute();
  await db
    .updateTable('auth.users')
    .set({ role_id: null })
    .where('role_id', '=', role.id)
    .execute();
  await db.deleteFrom('auth.roles').where('id', '=', role.id).execute();
}

// `any` is required here since migrations should be frozen in time. alternatively, keep a "snapshot" db interface.
export async function down(db: Kysely<any>): Promise<void> {
  const conflict = await db
    .selectFrom('auth.roles')
    .select('id')
    .where('code', '=', 'NO_ACCESS')
    .executeTakeFirst();
  if (conflict)
    throw new Error(
      'Cannot restore NO_ACCESS because that role code is already in use',
    );

  const role = await db
    .insertInto('auth.roles')
    .values({
      code: 'NO_ACCESS',
      role_name: 'No Access',
      is_system: true,
      is_active: true,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await db
    .updateTable('auth.users')
    .set({ role_id: role.id })
    .where('role_id', 'is', null)
    .execute();
  await db.schema
    .alterTable('auth.users')
    .alterColumn('role_id', (column: any) => column.setNotNull())
    .execute();
}
