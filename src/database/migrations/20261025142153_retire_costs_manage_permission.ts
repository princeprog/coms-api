import { sql, type Kysely } from 'kysely';

// The Costs & profit page and its manual stock-cost editor are retired.
// Receipts still set weighted-average costs; costs.read and costs.global_read
// keep gating profit on the Sales report and Dashboard.
// `any` is required here since migrations should be frozen in time.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    DELETE FROM coms_auth.role_permissions WHERE permission_id IN
      (SELECT id FROM coms_auth.permissions
        WHERE module_key = 'costs' AND action_key = 'manage');
    DELETE FROM coms_auth.permissions
      WHERE module_key = 'costs' AND action_key = 'manage';
  `.execute(db);
}

// Restores the permission only; role grants removed by `up` are not restored.
export async function down(db: Kysely<any>): Promise<void> {
  await db
    .insertInto('coms_auth.permissions')
    .values({
      module_key: 'costs',
      action_key: 'manage',
      description: 'Set stock item costs',
    })
    .execute();
}
