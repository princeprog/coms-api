import { sql, type Kysely } from 'kysely';

// Admin password resets: a temporary password must be changed at next sign-in.
// Roles that can update staff may reset their passwords.
// `any` is required here since migrations should be frozen in time.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    ALTER TABLE auth.users
      ADD COLUMN must_change_password boolean NOT NULL DEFAULT false,
      ADD COLUMN password_changed_at timestamptz;
    INSERT INTO auth.permissions (module_key, action_key, description)
    VALUES ('staff', 'password_reset', 'Reset staff passwords');
    INSERT INTO auth.role_permissions (role_id, permission_id)
    SELECT rp.role_id, target.id
    FROM auth.role_permissions rp
    JOIN auth.permissions source ON source.id = rp.permission_id
      AND source.module_key = 'staff' AND source.action_key = 'update'
    CROSS JOIN (SELECT id FROM auth.permissions
      WHERE module_key = 'staff' AND action_key = 'password_reset') target
    ON CONFLICT DO NOTHING;
  `.execute(db);
}

// `any` is required here since migrations should be frozen in time.
export async function down(db: Kysely<any>): Promise<void> {
  await sql`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM auth.users WHERE must_change_password)
    THEN RAISE EXCEPTION 'Pending password changes exist; use a forward correction.'; END IF;
    END $$;
    DELETE FROM auth.role_permissions WHERE permission_id IN (SELECT id FROM auth.permissions
      WHERE module_key = 'staff' AND action_key = 'password_reset');
    DELETE FROM auth.permissions WHERE module_key = 'staff' AND action_key = 'password_reset';
    ALTER TABLE auth.users DROP COLUMN password_changed_at, DROP COLUMN must_change_password;
  `.execute(db);
}
