import { sql, type Kysely } from 'kysely';

// COMS kept its accounts, roles and tokens in a schema named "auth". Hosted
// Postgres such as Supabase reserves that name for its own auth service, so
// move the COMS tables to "coms_auth". Renaming the schema keeps every table,
// sequence, index, constraint, foreign key, trigger and row as-is; only code
// that names the schema in SQL text needs updating, which here is the audit
// trigger function's actor lookup.

function auditRowFunction(schema: 'auth' | 'coms_auth') {
  return sql.raw(`
    CREATE OR REPLACE FUNCTION coms_audit_row() RETURNS trigger LANGUAGE plpgsql AS $fn$
    DECLARE
      before_row jsonb := CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END;
      after_row jsonb := CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END;
      current_row jsonb := coalesce(to_jsonb(NEW), to_jsonb(OLD));
      ignored text[] := TG_ARGV[2:];
      diff jsonb := '{}'::jsonb;
      field text;
      actor uuid := nullif(current_setting('coms.actor_id', true), '')::uuid;
    BEGIN
      FOR field IN SELECT jsonb_object_keys(current_row) LOOP
        CONTINUE WHEN field = ANY(ignored) OR field = 'id';
        CONTINUE WHEN TG_OP = 'UPDATE' AND before_row -> field IS NOT DISTINCT FROM after_row -> field;
        diff := diff || jsonb_build_object(field,
          jsonb_build_object('from', before_row -> field, 'to', after_row -> field));
      END LOOP;
      IF TG_OP = 'UPDATE' AND diff = '{}'::jsonb THEN RETURN NULL; END IF;
      INSERT INTO audit_events
        (actor_user_id, actor_name, action, entity_type, entity_id, entity_label, changes)
      VALUES (
        actor,
        (SELECT full_name FROM ${schema}.users WHERE id = actor),
        TG_ARGV[0] || '.' || CASE TG_OP WHEN 'INSERT' THEN 'created' WHEN 'UPDATE' THEN 'updated' ELSE 'deleted' END,
        TG_ARGV[0],
        coalesce(current_row ->> 'id', current_row ->> TG_ARGV[1]),
        current_row ->> TG_ARGV[1],
        diff
      );
      RETURN NULL;
    END $fn$;
  `);
}

// Only a COMS-owned "auth" schema may move: it must hold the COMS users table
// (identified by its hashed_password column), so a provider's own auth schema
// is never touched.
const comsUsersIn = (schema: string) => sql`
  EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema = ${schema} AND table_name = 'users'
      AND column_name = 'hashed_password')`;

// `any` is required here since migrations should be frozen in time.
export async function up(db: Kysely<any>): Promise<void> {
  const state = await sql<{ source: boolean; target: boolean }>`
    SELECT ${comsUsersIn('auth')} AS source,
      EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'coms_auth') AS target
  `.execute(db);
  const { source, target } = state.rows[0];
  if (target)
    throw new Error('Schema coms_auth already exists; refusing to rename.');
  if (!source)
    throw new Error(
      'Schema auth does not contain the COMS users table; refusing to rename.',
    );
  await sql`ALTER SCHEMA auth RENAME TO coms_auth`.execute(db);
  await auditRowFunction('coms_auth').execute(db);
}

// `any` is required here since migrations should be frozen in time.
export async function down(db: Kysely<any>): Promise<void> {
  const state = await sql<{ source: boolean; occupied: boolean }>`
    SELECT ${comsUsersIn('coms_auth')} AS source,
      EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'auth') AS occupied
  `.execute(db);
  const { source, occupied } = state.rows[0];
  // On hosts that reserve "auth" (such as Supabase) this rollback is refused.
  if (occupied)
    throw new Error(
      'Schema auth already exists; cannot move COMS tables back.',
    );
  if (!source)
    throw new Error('Schema coms_auth does not contain the COMS users table.');
  await sql`ALTER SCHEMA coms_auth RENAME TO auth`.execute(db);
  await auditRowFunction('auth').execute(db);
}
