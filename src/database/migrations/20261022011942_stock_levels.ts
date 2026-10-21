import { sql, type Kysely } from 'kysely';

// Reorder point and target level per stock item at the commissary or a
// branch. Changes are audited by the service as named events, so the log
// shows item and branch names. Commissary Manager may set levels; Super Admin
// always can.
// `any` is required here since migrations should be frozen in time.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE stock_levels (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      inventory_scope text NOT NULL CHECK (inventory_scope IN ('COMMISSARY', 'BRANCH')),
      branch_id uuid REFERENCES branches(id),
      stock_item_id uuid NOT NULL REFERENCES stock_items(id),
      reorder_level numeric NOT NULL CHECK (reorder_level >= 0),
      target_level numeric NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by_user_id uuid REFERENCES auth.users(id),
      CONSTRAINT stock_levels_scope_branch
        CHECK ((inventory_scope = 'COMMISSARY') = (branch_id IS NULL)),
      CONSTRAINT stock_levels_target_above_reorder
        CHECK (target_level > reorder_level)
    );
    CREATE UNIQUE INDEX stock_levels_commissary_item_unique
      ON stock_levels (stock_item_id) WHERE inventory_scope = 'COMMISSARY';
    CREATE UNIQUE INDEX stock_levels_branch_item_unique
      ON stock_levels (branch_id, stock_item_id) WHERE inventory_scope = 'BRANCH';
  `.execute(db);
  await db
    .insertInto('auth.permissions')
    .values({
      module_key: 'inventory',
      action_key: 'levels_manage',
      description: 'Set reorder and target stock levels',
    })
    .execute();
  await sql`
    INSERT INTO auth.role_permissions (role_id, permission_id)
    SELECT r.id, p.id FROM auth.roles r, auth.permissions p
    WHERE r.code = 'COMMISSARY_MANAGER' AND r.is_predefined
      AND p.module_key = 'inventory' AND p.action_key = 'levels_manage'
    ON CONFLICT DO NOTHING
  `.execute(db);
}

// `any` is required here since migrations should be frozen in time.
export async function down(db: Kysely<any>): Promise<void> {
  await sql`
    DELETE FROM auth.role_permissions WHERE permission_id IN
      (SELECT id FROM auth.permissions
        WHERE module_key = 'inventory' AND action_key = 'levels_manage');
    DELETE FROM auth.permissions
      WHERE module_key = 'inventory' AND action_key = 'levels_manage';
    DROP TABLE stock_levels;
  `.execute(db);
}
