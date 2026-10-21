import { sql, type Kysely } from 'kysely';

// [table, entity type, label column, ignored columns]
const audited = [
  [
    'products',
    'product',
    'product_name',
    [
      'created_at',
      'updated_at',
      'setup_revision',
      'price_revision',
      'recipe_revision',
    ],
  ],
  [
    'product_categories',
    'product_category',
    'name',
    ['created_at', 'updated_at'],
  ],
  [
    'stock_items',
    'stock_item',
    'stock_item_name',
    ['created_at', 'updated_at'],
  ],
  ['suppliers', 'supplier', 'supplier_name', ['created_at', 'updated_at']],
  ['branches', 'branch', 'branch_name', ['created_at', 'updated_at']],
  ['payment_methods', 'payment_method', 'name', ['created_at', 'updated_at']],
  ['business_day_rules', 'business_day', 'effective_from', ['created_at']],
  [
    'auth.users',
    'staff',
    'full_name',
    [
      'created_at',
      'updated_at',
      'hashed_password',
      'password_changed_at',
      'must_change_password',
    ],
  ],
  ['auth.roles', 'role', 'role_name', ['created_at', 'updated_at']],
] as const;

const triggerName = (table: string) =>
  `audit_${table.replace('auth.', 'auth_')}`;

// Append-only history of settings and security changes. Row triggers record
// field differences in the writer's transaction; the actor comes from the
// connection setting coms.actor_id (set per request by the API).
// `any` is required here since migrations should be frozen in time.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE audit_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      actor_user_id uuid,
      actor_name text,
      action text NOT NULL CHECK (char_length(action) BETWEEN 1 AND 80),
      entity_type text NOT NULL CHECK (char_length(entity_type) BETWEEN 1 AND 40),
      entity_id text,
      entity_label text,
      branch_id uuid,
      changes jsonb NOT NULL DEFAULT '{}'::jsonb,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE INDEX audit_events_occurred_idx ON audit_events (occurred_at DESC, id DESC);
    CREATE INDEX audit_events_entity_idx ON audit_events (entity_type, entity_id);
    CREATE INDEX audit_events_actor_idx ON audit_events (actor_user_id, occurred_at DESC);

    CREATE FUNCTION coms_audit_append_only() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      RAISE EXCEPTION 'audit_events is append-only';
    END $fn$;
    CREATE TRIGGER audit_events_no_change BEFORE UPDATE OR DELETE ON audit_events
      FOR EACH ROW EXECUTE FUNCTION coms_audit_append_only();
    CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events
      FOR EACH STATEMENT EXECUTE FUNCTION coms_audit_append_only();

    CREATE FUNCTION coms_audit_row() RETURNS trigger LANGUAGE plpgsql AS $fn$
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
        (SELECT full_name FROM auth.users WHERE id = actor),
        TG_ARGV[0] || '.' || CASE TG_OP WHEN 'INSERT' THEN 'created' WHEN 'UPDATE' THEN 'updated' ELSE 'deleted' END,
        TG_ARGV[0],
        coalesce(current_row ->> 'id', current_row ->> TG_ARGV[1]),
        current_row ->> TG_ARGV[1],
        diff
      );
      RETURN NULL;
    END $fn$;
  `.execute(db);
  for (const [table, entity, label, ignored] of audited)
    await sql
      .raw(
        `CREATE TRIGGER ${triggerName(table)} AFTER INSERT OR UPDATE OR DELETE ON ${table}
          FOR EACH ROW EXECUTE FUNCTION coms_audit_row('${entity}', '${label}'${ignored
            .map((column) => `, '${column}'`)
            .join('')})`,
      )
      .execute(db);
  await db
    .insertInto('auth.permissions')
    .values({
      module_key: 'audit',
      action_key: 'read',
      description: 'View the audit log of settings and security changes',
    })
    .execute();
}

// `any` is required here since migrations should be frozen in time.
export async function down(db: Kysely<any>): Promise<void> {
  await sql`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM audit_events) THEN
      RAISE EXCEPTION 'Audit history exists; use a forward correction.'; END IF;
    END $$`.execute(db);
  for (const [table] of audited)
    await sql.raw(`DROP TRIGGER ${triggerName(table)} ON ${table}`).execute(db);
  await sql`
    DELETE FROM auth.role_permissions WHERE permission_id IN
      (SELECT id FROM auth.permissions WHERE module_key = 'audit');
    DELETE FROM auth.permissions WHERE module_key = 'audit';
    DROP TABLE audit_events;
    DROP FUNCTION coms_audit_row();
    DROP FUNCTION coms_audit_append_only();
  `.execute(db);
}
