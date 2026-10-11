import { sql, type Kysely } from 'kysely';

// `any` is required here since migrations should be frozen in time. alternatively, keep a "snapshot" db interface.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    ALTER TABLE stock_items ADD COLUMN usage_types text[] NOT NULL DEFAULT ARRAY['OPERATING_SUPPLY'];
    UPDATE stock_items s SET usage_types=ARRAY['INGREDIENT'] WHERE EXISTS(SELECT 1 FROM product_ingredients i WHERE i.stock_item_id=s.id);
    ALTER TABLE stock_items ADD CONSTRAINT stock_items_usage_types CHECK (
      cardinality(usage_types) BETWEEN 1 AND 4 AND usage_types <@ ARRAY['INGREDIENT','PACKAGING','READY_TO_SELL','OPERATING_SUPPLY']
      AND array_position(usage_types,NULL) IS NULL
      AND cardinality(array_positions(usage_types,'INGREDIENT'))<=1 AND cardinality(array_positions(usage_types,'PACKAGING'))<=1
      AND cardinality(array_positions(usage_types,'READY_TO_SELL'))<=1 AND cardinality(array_positions(usage_types,'OPERATING_SUPPLY'))<=1);
    CREATE INDEX stock_items_usage_types_idx ON stock_items USING gin(usage_types);
    ALTER TABLE products ADD COLUMN preparation_type text NOT NULL DEFAULT 'PREPARED' CHECK (preparation_type IN ('PREPARED','READY_TO_SELL'));
    ALTER TABLE products ADD COLUMN setup_revision integer NOT NULL DEFAULT 1 CHECK(setup_revision>0);
    ALTER TABLE product_ingredients ADD COLUMN component_type text NOT NULL DEFAULT 'INGREDIENT' CHECK(component_type IN ('INGREDIENT','PACKAGING','READY_TO_SELL'));
    CREATE TABLE product_setup_operations (
      idempotency_key uuid PRIMARY KEY, actor_user_id uuid NOT NULL REFERENCES auth.users(id),
      product_id uuid NOT NULL REFERENCES products(id), fingerprint text NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
    );
  `.execute(db);
}

// `any` is required here since migrations should be frozen in time. alternatively, keep a "snapshot" db interface.
export async function down(db: Kysely<any>): Promise<void> {
  await sql`DO $$ BEGIN
    IF EXISTS(SELECT 1 FROM product_setup_operations) OR EXISTS(SELECT 1 FROM products WHERE preparation_type<>'PREPARED')
      OR EXISTS(SELECT 1 FROM product_ingredients WHERE component_type<>'INGREDIENT')
      OR EXISTS(SELECT 1 FROM stock_items s WHERE usage_types<>CASE WHEN EXISTS(SELECT 1 FROM product_ingredients i WHERE i.stock_item_id=s.id) THEN ARRAY['INGREDIENT'] ELSE ARRAY['OPERATING_SUPPLY'] END)
    THEN RAISE EXCEPTION 'Stock classification or product setup data exists; use a forward correction.'; END IF;
    END $$;
    DROP TABLE product_setup_operations;
    ALTER TABLE product_ingredients DROP COLUMN component_type;
    ALTER TABLE products DROP COLUMN preparation_type, DROP COLUMN setup_revision;
    ALTER TABLE stock_items DROP COLUMN usage_types;
  `.execute(db);
  // For more info, see: https://kysely.dev/docs/migrations
}
