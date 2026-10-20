import { sql, type Kysely } from 'kysely';

const permissions = [
  ['shifts', 'read', 'View register shifts'],
  ['shifts', 'operate', 'Open, close and record cash for your register shift'],
  ['shifts', 'review', 'Review and force-close register shifts'],
] as const;

// Existing roles keep working: whoever sells may run a shift, whoever submits
// daily reports reviews shifts, and report/sales readers can view shifts.
const grantSources = {
  'shifts.operate': ['sales.create'],
  'shifts.read': ['sales.create', 'sales.read', 'daily_reports.read'],
  'shifts.review': ['daily_reports.submit'],
} as const;

const kinds =
  "'DISPATCH_SENT','DISPATCH_DISCREPANCY','DISPATCH_RESOLVED','REPORT_SUBMITTED','REPORT_RETURNED','REPORT_APPROVED','DISPATCH_OVERDUE','DISPATCH_LATE_COUNT'";

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE business_day_rules (
      effective_from date PRIMARY KEY,
      start_time time NOT NULL CHECK (
        extract(second FROM start_time) = 0
        AND extract(minute FROM start_time) IN (0, 30)
      ),
      created_by_user_id uuid REFERENCES auth.users(id),
      created_at timestamptz NOT NULL DEFAULT now()
    );
    -- Midnight keeps existing business dates unchanged until Super Admin sets a start.
    INSERT INTO business_day_rules (effective_from, start_time) VALUES ('2000-01-01', '00:00');

    CREATE FUNCTION coms_business_day_start(d date) RETURNS timestamptz
    LANGUAGE sql STABLE AS $fn$
      SELECT ((d + rule.start_time)::timestamp AT TIME ZONE 'Asia/Manila')
      FROM business_day_rules AS rule
      WHERE rule.effective_from <= d
      ORDER BY rule.effective_from DESC
      LIMIT 1
    $fn$;

    -- Each business day ends where the next one starts, so days never overlap or leave gaps.
    CREATE FUNCTION coms_business_day_end(d date) RETURNS timestamptz
    LANGUAGE sql STABLE AS $fn$ SELECT coms_business_day_start(d + 1) $fn$;

    CREATE FUNCTION coms_business_date(t timestamptz) RETURNS date
    LANGUAGE sql STABLE AS $fn$
      SELECT CASE
        WHEN t < coms_business_day_start((t AT TIME ZONE 'Asia/Manila')::date)
        THEN (t AT TIME ZONE 'Asia/Manila')::date - 1
        ELSE (t AT TIME ZONE 'Asia/Manila')::date
      END
    $fn$;

    CREATE TABLE register_shifts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      branch_id uuid NOT NULL REFERENCES branches(id),
      business_date date NOT NULL,
      shift_number integer NOT NULL CHECK (shift_number > 0),
      status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED', 'REVIEWED')),
      opened_by_user_id uuid NOT NULL REFERENCES auth.users(id),
      opened_at timestamptz NOT NULL DEFAULT now(),
      opening_float numeric NOT NULL CHECK (opening_float >= 0),
      expected_opening_float numeric,
      opening_difference numeric,
      open_idempotency_key uuid NOT NULL UNIQUE,
      closed_by_user_id uuid REFERENCES auth.users(id),
      closed_at timestamptz,
      close_type text CHECK (close_type IN ('CASHIER', 'FORCED')),
      force_close_reason varchar(500),
      close_idempotency_key uuid UNIQUE,
      counted_cash numeric CHECK (counted_cash >= 0),
      left_in_drawer numeric CHECK (left_in_drawer >= 0),
      expected_cash numeric,
      cash_difference numeric,
      cash_sales_amount numeric,
      non_cash_sales_amount numeric,
      cash_refunds_amount numeric,
      cash_in_amount numeric,
      cash_out_amount numeric,
      sales_count integer,
      voids_count integer,
      cashier_explanation varchar(500),
      reviewed_by_user_id uuid REFERENCES auth.users(id),
      reviewed_at timestamptz,
      review_note varchar(500),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (branch_id, business_date, shift_number),
      CHECK ((status = 'OPEN') = (closed_at IS NULL)),
      CHECK (status = 'OPEN' OR (
        counted_cash IS NOT NULL AND left_in_drawer IS NOT NULL
        AND left_in_drawer <= counted_cash AND expected_cash IS NOT NULL
        AND cash_difference IS NOT NULL AND close_type IS NOT NULL
        AND closed_by_user_id IS NOT NULL
      )),
      CHECK (close_type IS DISTINCT FROM 'FORCED' OR force_close_reason IS NOT NULL),
      CHECK ((status = 'REVIEWED') = (reviewed_at IS NOT NULL AND reviewed_by_user_id IS NOT NULL))
    );
    CREATE UNIQUE INDEX register_shifts_one_open ON register_shifts (branch_id) WHERE status = 'OPEN';
    CREATE INDEX register_shifts_branch_date ON register_shifts (branch_id, business_date DESC, shift_number DESC);

    CREATE TABLE register_shift_cash_movements (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      shift_id uuid NOT NULL REFERENCES register_shifts(id),
      direction text NOT NULL CHECK (direction IN ('IN', 'OUT')),
      amount numeric NOT NULL CHECK (amount > 0),
      reason varchar(300) NOT NULL CHECK (length(btrim(reason)) > 0),
      actor_user_id uuid NOT NULL REFERENCES auth.users(id),
      idempotency_key uuid NOT NULL UNIQUE,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX register_shift_cash_movements_shift ON register_shift_cash_movements (shift_id, created_at);

    ALTER TABLE sales
      ADD COLUMN shift_id uuid REFERENCES register_shifts(id),
      ADD COLUMN payment_kind text CHECK (payment_kind IN ('CASH', 'NON_CASH')),
      ADD CONSTRAINT sales_shift_payment_kind CHECK (shift_id IS NULL OR payment_kind IS NOT NULL);
    CREATE INDEX sales_shift ON sales (shift_id) WHERE shift_id IS NOT NULL;
    ALTER TABLE sale_events ADD COLUMN refund_shift_id uuid REFERENCES register_shifts(id);
    CREATE INDEX sale_events_refund_shift ON sale_events (refund_shift_id) WHERE refund_shift_id IS NOT NULL;

    ALTER TABLE notification_events ADD COLUMN shift_id uuid UNIQUE REFERENCES register_shifts(id) ON DELETE CASCADE;
    ALTER TABLE notification_events
      DROP CONSTRAINT notification_kind_check,
      DROP CONSTRAINT notification_source_check,
      DROP CONSTRAINT notification_target_check;
    ALTER TABLE notification_events ADD CONSTRAINT notification_kind_check CHECK (kind IN (${sql.raw(kinds)}, 'SHIFT_NEEDS_REVIEW'));
    ALTER TABLE notification_events ADD CONSTRAINT notification_source_check CHECK (num_nonnulls(dispatch_event_id, discrepancy_event_id, report_event_id, receiving_source_id, shift_id) = 1);
    ALTER TABLE notification_events ADD CONSTRAINT notification_target_check CHECK (
      (kind = 'DISPATCH_OVERDUE' AND dispatch_id IS NULL AND report_id IS NULL AND receiving_source_id IS NOT NULL)
      OR (kind = 'DISPATCH_LATE_COUNT' AND dispatch_id IS NOT NULL AND report_id IS NULL AND receiving_source_id IS NOT NULL)
      OR (kind IN ('DISPATCH_SENT','DISPATCH_DISCREPANCY','DISPATCH_RESOLVED') AND dispatch_id IS NOT NULL AND report_id IS NULL AND receiving_source_id IS NULL AND report_event_id IS NULL)
      OR (kind LIKE 'REPORT_%' AND report_id IS NOT NULL AND dispatch_id IS NULL AND report_event_id IS NOT NULL)
      OR (kind = 'SHIFT_NEEDS_REVIEW' AND shift_id IS NOT NULL AND dispatch_id IS NULL AND report_id IS NULL)
    );

    CREATE TABLE migration_shift_grants (
      role_id bigint NOT NULL REFERENCES auth.roles(id),
      permission_id bigint NOT NULL REFERENCES auth.permissions(id),
      PRIMARY KEY (role_id, permission_id)
    );
  `.execute(db);

  for (const [module_key, action_key, description] of permissions)
    await db
      .insertInto('auth.permissions')
      .values({ module_key, action_key, description })
      .execute();

  for (const [target, sources] of Object.entries(grantSources)) {
    const [targetModule, targetAction] = target.split('.');
    const sourceKeys = sources.map((key) => key.split('.'));
    await sql`
      WITH target AS (
        SELECT id FROM auth.permissions
        WHERE module_key = ${targetModule} AND action_key = ${targetAction}
      ), roles AS (
        SELECT DISTINCT rp.role_id
        FROM auth.role_permissions rp
        JOIN auth.permissions p ON p.id = rp.permission_id
        WHERE (p.module_key, p.action_key) IN (${sql.join(
          sourceKeys.map(([m, a]) => sql`(${m}, ${a})`),
        )})
      ), inserted AS (
        INSERT INTO auth.role_permissions (role_id, permission_id)
        SELECT roles.role_id, target.id FROM roles CROSS JOIN target
        ON CONFLICT DO NOTHING
        RETURNING role_id, permission_id
      )
      INSERT INTO migration_shift_grants (role_id, permission_id)
      SELECT role_id, permission_id FROM inserted
    `.execute(db);
  }
}

export async function down(db: Kysely<any>): Promise<void> {
  const used = await sql`
    SELECT 1 FROM register_shifts
    UNION ALL SELECT 1 FROM business_day_rules WHERE effective_from <> '2000-01-01' OR start_time <> '00:00'
    LIMIT 1
  `.execute(db);
  if (used.rows.length)
    throw new Error(
      'Shifts or business-day settings are in use; preserve their history with a forward migration.',
    );
  const extra = await sql`
    SELECT 1 FROM auth.role_permissions rp JOIN auth.permissions p ON p.id = rp.permission_id
    WHERE p.module_key = 'shifts'
      AND NOT EXISTS (SELECT 1 FROM migration_shift_grants g WHERE g.role_id = rp.role_id AND g.permission_id = rp.permission_id)
    LIMIT 1
  `.execute(db);
  if (extra.rows.length)
    throw new Error(
      'Shift permissions were assigned after rollout; refusing to remove administrator grants.',
    );
  await sql`
    DELETE FROM auth.role_permissions rp USING migration_shift_grants g
      WHERE rp.role_id = g.role_id AND rp.permission_id = g.permission_id;
    DROP TABLE migration_shift_grants;
    DELETE FROM auth.permissions WHERE module_key = 'shifts';
    DELETE FROM notification_events WHERE shift_id IS NOT NULL;
    ALTER TABLE notification_events
      DROP CONSTRAINT notification_kind_check,
      DROP CONSTRAINT notification_source_check,
      DROP CONSTRAINT notification_target_check;
    ALTER TABLE notification_events DROP COLUMN shift_id;
    ALTER TABLE notification_events ADD CONSTRAINT notification_kind_check CHECK (kind IN (${sql.raw(kinds)}));
    ALTER TABLE notification_events ADD CONSTRAINT notification_source_check CHECK (num_nonnulls(dispatch_event_id, discrepancy_event_id, report_event_id, receiving_source_id) = 1);
    ALTER TABLE notification_events ADD CONSTRAINT notification_target_check CHECK (
      (kind = 'DISPATCH_OVERDUE' AND dispatch_id IS NULL AND report_id IS NULL AND receiving_source_id IS NOT NULL)
      OR (kind = 'DISPATCH_LATE_COUNT' AND dispatch_id IS NOT NULL AND report_id IS NULL AND receiving_source_id IS NOT NULL)
      OR (kind IN ('DISPATCH_SENT','DISPATCH_DISCREPANCY','DISPATCH_RESOLVED') AND dispatch_id IS NOT NULL AND report_id IS NULL AND receiving_source_id IS NULL AND report_event_id IS NULL)
      OR (kind LIKE 'REPORT_%' AND report_id IS NOT NULL AND dispatch_id IS NULL AND report_event_id IS NOT NULL)
    );
    ALTER TABLE sale_events DROP COLUMN refund_shift_id;
    ALTER TABLE sales DROP CONSTRAINT sales_shift_payment_kind, DROP COLUMN payment_kind, DROP COLUMN shift_id;
    DROP TABLE register_shift_cash_movements;
    DROP TABLE register_shifts;
    DROP FUNCTION coms_business_date(timestamptz);
    DROP FUNCTION coms_business_day_end(date);
    DROP FUNCTION coms_business_day_start(date);
    DROP TABLE business_day_rules;
  `.execute(db);
}
