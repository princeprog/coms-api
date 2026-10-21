import { sql, type Kysely } from 'kysely';

// Permission for the owner-facing Sales report. No role receives it by
// default; Super Admin always has access.
// `any` is required here since migrations should be frozen in time.
export async function up(db: Kysely<any>): Promise<void> {
  await db
    .insertInto('auth.permissions')
    .values({
      module_key: 'sales_report',
      action_key: 'read',
      description: 'View the sales report',
    })
    .execute();
}

// `any` is required here since migrations should be frozen in time.
export async function down(db: Kysely<any>): Promise<void> {
  await sql`
    DELETE FROM auth.role_permissions WHERE permission_id IN
      (SELECT id FROM auth.permissions WHERE module_key = 'sales_report');
    DELETE FROM auth.permissions WHERE module_key = 'sales_report';
  `.execute(db);
}
