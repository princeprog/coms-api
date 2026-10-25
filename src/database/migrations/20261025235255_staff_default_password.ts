import { sql, type Kysely } from 'kysely';

// No seeded credential: Super Admin sets the default before creating staff.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE coms_auth.staff_onboarding_settings (
    id boolean PRIMARY KEY DEFAULT true CHECK (id),
    hashed_password text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  ); REVOKE ALL ON coms_auth.staff_onboarding_settings FROM PUBLIC;`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('coms_auth.staff_onboarding_settings').execute();
}
