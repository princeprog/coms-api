import { sql, type Kysely } from 'kysely';

const permissions = [
  ['costs', 'read', 'View costs and profit for assigned branches'],
  ['costs', 'global_read', 'View costs and profit for all branches'],
  ['costs', 'manage', 'Set stock item costs'],
] as const;

// One company-wide weighted-average cost per stock item, updated by commissary
// receipts or set manually. Sales and approved reports snapshot it so later
// cost changes never rewrite history. No role is granted cost access here.
// `any` is required here since migrations should be frozen in time.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE stock_item_costs (
      stock_item_id uuid PRIMARY KEY REFERENCES stock_items(id) ON DELETE CASCADE,
      average_unit_cost numeric NOT NULL CHECK (average_unit_cost >= 0),
      last_unit_cost numeric CHECK (last_unit_cost >= 0),
      last_received_at timestamptz,
      cost_source text NOT NULL CHECK (cost_source IN ('RECEIPT', 'MANUAL')),
      updated_by_user_id uuid REFERENCES auth.users(id),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO stock_item_costs
      (stock_item_id, average_unit_cost, last_unit_cost, last_received_at, cost_source)
    SELECT
      totals.stock_item_id,
      round(totals.value / totals.quantity, 6),
      latest.unit_cost,
      latest.received_at,
      'RECEIPT'
    FROM (
      SELECT i.stock_item_id, sum(i.quantity_received * i.unit_cost) AS value,
             sum(i.quantity_received) AS quantity
      FROM supplier_receipt_items i
      WHERE i.quantity_received > 0
      GROUP BY i.stock_item_id
    ) totals
    JOIN LATERAL (
      SELECT i.unit_cost, r.received_at::timestamptz AS received_at
      FROM supplier_receipt_items i
      JOIN supplier_receipts r ON r.id = i.supplier_receipt_id
      WHERE i.stock_item_id = totals.stock_item_id AND i.quantity_received > 0
      ORDER BY r.received_at DESC, r.recorded_at DESC, i.created_at DESC
      LIMIT 1
    ) latest ON true
    WHERE totals.quantity > 0;
    ALTER TABLE sale_item_consumptions
      ADD COLUMN unit_cost numeric CHECK (unit_cost >= 0);
    ALTER TABLE daily_branch_report_items
      ADD COLUMN unit_cost numeric CHECK (unit_cost >= 0);
  `.execute(db);
  for (const [module_key, action_key, description] of permissions)
    await db
      .insertInto('auth.permissions')
      .values({ module_key, action_key, description })
      .execute();
}

// `any` is required here since migrations should be frozen in time.
export async function down(db: Kysely<any>): Promise<void> {
  await sql`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM sale_item_consumptions WHERE unit_cost IS NOT NULL)
      OR EXISTS (SELECT 1 FROM daily_branch_report_items WHERE unit_cost IS NOT NULL)
      OR EXISTS (SELECT 1 FROM stock_item_costs WHERE cost_source = 'MANUAL')
    THEN RAISE EXCEPTION 'Cost history exists; use a forward correction.'; END IF;
    END $$;
    DELETE FROM auth.role_permissions WHERE permission_id IN
      (SELECT id FROM auth.permissions WHERE module_key = 'costs');
    DELETE FROM auth.permissions WHERE module_key = 'costs';
    ALTER TABLE daily_branch_report_items DROP COLUMN unit_cost;
    ALTER TABLE sale_item_consumptions DROP COLUMN unit_cost;
    DROP TABLE stock_item_costs;
  `.execute(db);
}
