import { sql, type Kysely } from 'kysely';

const categories = [
  'Rent',
  'Utilities',
  'Transportation',
  'Repairs & maintenance',
  'Cleaning & operating supplies',
  'Staff meals',
  'Salaries & wages',
  'Fees & permits',
  'Other',
];
const actions = [
  'read',
  'global_read',
  'commissary_read',
  'create',
  'update',
  'void',
  'categories_manage',
];

// Migrations freeze their schema independently of generated application types.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE expense_categories (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name varchar(80) NOT NULL CHECK (length(btrim(name)) > 0 AND lower(btrim(name)) <> 'stock purchases'),
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX expense_categories_name_unique ON expense_categories (lower(btrim(name)));
    CREATE TABLE expenses (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      expense_date date NOT NULL,
      inventory_scope varchar(20) NOT NULL CHECK (inventory_scope IN ('COMMISSARY','BRANCH')),
      branch_id uuid REFERENCES branches(id),
      category_id uuid NOT NULL REFERENCES expense_categories(id),
      description varchar(160) NOT NULL CHECK (length(btrim(description)) > 0),
      amount numeric(11,2) NOT NULL CHECK (amount > 0),
      payment_method varchar(20) NOT NULL CHECK (payment_method IN ('CASH','BANK_TRANSFER','EWALLET','CARD','OTHER')),
      cash_source varchar(20),
      cash_movement_id uuid REFERENCES register_shift_cash_movements(id),
      payee varchar(160), reference varchar(100), notes varchar(1000),
      status varchar(20) NOT NULL DEFAULT 'RECORDED' CHECK (status IN ('RECORDED','VOIDED')),
      revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
      created_by_user_id uuid NOT NULL REFERENCES coms_auth.users(id),
      updated_by_user_id uuid NOT NULL REFERENCES coms_auth.users(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT expenses_scope_branch CHECK ((inventory_scope = 'COMMISSARY') = (branch_id IS NULL)),
      CONSTRAINT expenses_cash_source CHECK (
        (payment_method <> 'CASH' AND cash_source IS NULL AND cash_movement_id IS NULL)
        OR (payment_method = 'CASH' AND cash_source IS NOT NULL AND (
          (cash_source = 'OTHER' AND cash_movement_id IS NULL)
          OR (cash_source = 'REGISTER' AND cash_movement_id IS NOT NULL AND inventory_scope = 'BRANCH')
        ))
      )
    );
    CREATE INDEX expenses_location_date_idx ON expenses (inventory_scope, branch_id, expense_date DESC, id);
    CREATE INDEX expenses_date_idx ON expenses (expense_date DESC, id);
    CREATE INDEX expenses_category_date_idx ON expenses (category_id, expense_date DESC);
    CREATE UNIQUE INDEX expenses_active_cash_movement_unique ON expenses (cash_movement_id)
      WHERE status = 'RECORDED' AND cash_movement_id IS NOT NULL;
    CREATE TABLE expense_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      expense_id uuid NOT NULL REFERENCES expenses(id),
      action varchar(20) NOT NULL CHECK (action IN ('CREATED','UPDATED','VOIDED')),
      reason varchar(500),
      actor_user_id uuid NOT NULL REFERENCES coms_auth.users(id),
      idempotency_key uuid NOT NULL UNIQUE,
      request_payload jsonb NOT NULL,
      before_values jsonb,
      after_values jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CHECK (action = 'CREATED' OR (reason IS NOT NULL AND length(btrim(reason)) > 0))
    );
    CREATE INDEX expense_events_history_idx ON expense_events (expense_id, created_at, id);
    CREATE FUNCTION prevent_expense_event_change() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'Expense history is append-only'; END; $$;
    CREATE TRIGGER expense_events_immutable BEFORE UPDATE OR DELETE ON expense_events
      FOR EACH ROW EXECUTE FUNCTION prevent_expense_event_change();
  `.execute(db);
  await db
    .insertInto('expense_categories')
    .values(categories.map((name) => ({ name })))
    .execute();
  await db
    .insertInto('coms_auth.permissions')
    .values(
      actions.map((action_key) => ({
        module_key: 'expenses',
        action_key,
        description: `Expenses: ${action_key.replaceAll('_', ' ')}`,
      })),
    )
    .execute();
  await sql`
    INSERT INTO coms_auth.role_permissions (role_id, permission_id)
    SELECT r.id,p.id FROM coms_auth.roles r CROSS JOIN coms_auth.permissions p
    WHERE r.is_predefined AND r.code IN ('BRANCH_MANAGER','COMMISSARY_MANAGER')
      AND p.module_key = 'expenses'
      AND (p.action_key IN ('read','create','update','void')
        OR (r.code = 'COMMISSARY_MANAGER' AND p.action_key = 'commissary_read'))
    ON CONFLICT DO NOTHING;
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  const used = await sql<{ used: boolean }>`
    SELECT EXISTS(SELECT 1 FROM expenses) OR EXISTS(SELECT 1 FROM expense_events)
      OR (SELECT count(*) FROM expense_categories) <> ${categories.length}
      OR EXISTS(SELECT 1 FROM expense_categories WHERE NOT is_active OR updated_at <> created_at
        OR name NOT IN (${sql.join(categories)}))
      OR EXISTS(SELECT 1 FROM coms_auth.role_permissions rp
        JOIN coms_auth.permissions p ON p.id=rp.permission_id JOIN coms_auth.roles r ON r.id=rp.role_id
        WHERE p.module_key='expenses' AND NOT (r.is_predefined
          AND r.code IN ('BRANCH_MANAGER','COMMISSARY_MANAGER')
          AND (p.action_key IN ('read','create','update','void')
            OR (r.code='COMMISSARY_MANAGER' AND p.action_key='commissary_read')))) AS used
  `.execute(db);
  if (used.rows[0].used)
    throw new Error(
      'Keep the additive expenses schema while expense history, category changes or custom grants exist',
    );
  await sql`
    DELETE FROM coms_auth.role_permissions WHERE permission_id IN (SELECT id FROM coms_auth.permissions WHERE module_key='expenses');
    DELETE FROM coms_auth.permissions WHERE module_key='expenses';
    DROP TABLE expense_events;
    DROP FUNCTION prevent_expense_event_change();
    DROP TABLE expenses;
    DROP TABLE expense_categories;
  `.execute(db);
}
