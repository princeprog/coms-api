import { sql, type Kysely } from 'kysely';

// Every COMS table keeps row-level security on, so the Supabase Data API cannot
// read it even if schema access is granted later. Supabase only auto-enables RLS
// on public tables. The API connects as the table owner and is unaffected.
// `any` is required here since migrations should be frozen in time.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE coms_auth.staff_onboarding_settings ENABLE ROW LEVEL SECURITY`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE coms_auth.staff_onboarding_settings DISABLE ROW LEVEL SECURITY`.execute(
    db,
  );
}
