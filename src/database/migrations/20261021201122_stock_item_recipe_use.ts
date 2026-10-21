import { sql, type Kysely } from 'kysely';

// Recipe pickers list stock that can be used in recipes. Usage was hidden after
// 2026-10-10 and left almost everything as OPERATING_SUPPLY, so reset it: every
// item is usable in recipes except cleaning supplies.
// `any` is required here since migrations should be frozen in time.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    UPDATE stock_items
    SET usage_types = CASE
      WHEN lower(btrim(category)) = 'cleaning supplies' THEN ARRAY['OPERATING_SUPPLY']
      ELSE ARRAY['INGREDIENT'] END;
    ALTER TABLE stock_items ALTER COLUMN usage_types SET DEFAULT ARRAY['INGREDIENT'];
  `.execute(db);
}

// Restores the classification rule of 20261010174904_stock_usage_product_setup.
// `any` is required here since migrations should be frozen in time.
export async function down(db: Kysely<any>): Promise<void> {
  await sql`
    ALTER TABLE stock_items ALTER COLUMN usage_types SET DEFAULT ARRAY['OPERATING_SUPPLY'];
    UPDATE stock_items s SET usage_types = CASE
      WHEN EXISTS (SELECT 1 FROM product_ingredients i WHERE i.stock_item_id = s.id) THEN ARRAY['INGREDIENT']
      ELSE ARRAY['OPERATING_SUPPLY'] END;
  `.execute(db);
}
