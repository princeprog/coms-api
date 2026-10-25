import { sql, type Kysely } from 'kysely';

// Work schedules sit beside register (cash) shifts: branches define their shift
// times, staff get a weekly pattern plus dated exceptions, and opening a
// register records whether the opener was scheduled. Opening is never blocked.
// Weekdays use ISO numbering (1 = Monday … 7 = Sunday).
// `any` is required here since migrations should be frozen in time.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE branch_shift_templates (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      branch_id uuid NOT NULL REFERENCES branches(id),
      name varchar(40) NOT NULL CHECK (btrim(name) <> ''),
      start_time time NOT NULL,
      end_time time NOT NULL,
      weekdays smallint[] NOT NULL,
      is_active boolean NOT NULL DEFAULT true,
      revision integer NOT NULL DEFAULT 1,
      created_by_user_id uuid REFERENCES coms_auth.users(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT branch_shift_templates_half_hours CHECK (
        extract(second FROM start_time) = 0 AND extract(minute FROM start_time) IN (0, 30)
        AND extract(second FROM end_time) = 0 AND extract(minute FROM end_time) IN (0, 30)
      ),
      CONSTRAINT branch_shift_templates_has_length CHECK (start_time <> end_time),
      CONSTRAINT branch_shift_templates_weekdays CHECK (
        cardinality(weekdays) BETWEEN 1 AND 7 AND weekdays <@ ARRAY[1,2,3,4,5,6,7]::smallint[]
      )
    );
    CREATE UNIQUE INDEX branch_shift_templates_active_name
      ON branch_shift_templates (branch_id, lower(btrim(name))) WHERE is_active;
    CREATE INDEX branch_shift_templates_branch ON branch_shift_templates (branch_id);

    CREATE TABLE staff_shift_assignments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      branch_id uuid NOT NULL REFERENCES branches(id),
      user_id uuid NOT NULL REFERENCES coms_auth.users(id),
      template_id uuid NOT NULL REFERENCES branch_shift_templates(id),
      weekday smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),
      created_by_user_id uuid REFERENCES coms_auth.users(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (user_id, template_id, weekday)
    );
    CREATE INDEX staff_shift_assignments_branch ON staff_shift_assignments (branch_id, weekday);

    CREATE TABLE staff_shift_exceptions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      branch_id uuid NOT NULL REFERENCES branches(id),
      user_id uuid NOT NULL REFERENCES coms_auth.users(id),
      template_id uuid NOT NULL REFERENCES branch_shift_templates(id),
      work_date date NOT NULL,
      kind text NOT NULL CHECK (kind IN ('OFF', 'EXTRA')),
      reason varchar(200),
      created_by_user_id uuid REFERENCES coms_auth.users(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (user_id, template_id, work_date, kind)
    );
    CREATE INDEX staff_shift_exceptions_branch_date ON staff_shift_exceptions (branch_id, work_date);

    ALTER TABLE register_shifts
      ADD COLUMN schedule_status text
        CHECK (schedule_status IN ('SCHEDULED', 'UNSCHEDULED', 'NO_SCHEDULE')),
      ADD COLUMN scheduled_shift_name varchar(40);

    CREATE TRIGGER audit_branch_shift_templates AFTER INSERT OR UPDATE OR DELETE ON branch_shift_templates
      FOR EACH ROW EXECUTE FUNCTION coms_audit_row('shift_template', 'name', 'created_at', 'updated_at', 'revision');
  `.execute(db);
  await db
    .insertInto('coms_auth.permissions')
    .values([
      {
        module_key: 'schedules',
        action_key: 'read',
        description: 'View branch work schedules',
      },
      {
        module_key: 'schedules',
        action_key: 'manage',
        description: 'Set up branch shifts and assign staff to them',
      },
    ])
    .execute();
  await sql`
    INSERT INTO coms_auth.role_permissions (role_id, permission_id)
    SELECT r.id, p.id FROM coms_auth.roles r CROSS JOIN coms_auth.permissions p
    WHERE r.is_predefined AND r.code = 'BRANCH_MANAGER' AND p.module_key = 'schedules'
    ON CONFLICT DO NOTHING
  `.execute(db);
}

// `any` is required here since migrations should be frozen in time.
export async function down(db: Kysely<any>): Promise<void> {
  await sql`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM branch_shift_templates)
      OR EXISTS (SELECT 1 FROM register_shifts WHERE schedule_status IS NOT NULL)
    THEN RAISE EXCEPTION 'Schedules are in use; use a forward correction.'; END IF;
  END $$`.execute(db);
  await sql`
    DELETE FROM coms_auth.role_permissions WHERE permission_id IN
      (SELECT id FROM coms_auth.permissions WHERE module_key = 'schedules');
    DELETE FROM coms_auth.permissions WHERE module_key = 'schedules';
    ALTER TABLE register_shifts DROP COLUMN schedule_status, DROP COLUMN scheduled_shift_name;
    DROP TABLE staff_shift_exceptions;
    DROP TABLE staff_shift_assignments;
    DROP TABLE branch_shift_templates;
  `.execute(db);
}
