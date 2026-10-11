import { sql, type Kysely } from 'kysely';

// `any` is required here since migrations should be frozen in time. alternatively, keep a "snapshot" db interface.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    LOCK TABLE products, branch_products, branch_product_prices, sales IN ACCESS EXCLUSIVE MODE;
    DO $$ DECLARE unresolved text; BEGIN
      SELECT string_agg(p.product_name || ' (' || p.id::text || ')', ', ' ORDER BY p.product_name)
      INTO unresolved
      FROM products p
      LEFT JOIN LATERAL (
        SELECT count(DISTINCT price) AS choices FROM (
          SELECT price FROM branch_product_prices WHERE product_id=p.id
          UNION ALL SELECT price FROM branch_products WHERE product_id=p.id
        ) prices
      ) existing ON true
      WHERE existing.choices<>1;
      IF unresolved IS NOT NULL THEN
        RAISE EXCEPTION 'Supply an explicit selling price for products with missing or conflicting prices before migration: %', unresolved;
      END IF;
    END $$;
    ALTER TABLE products ADD COLUMN price numeric, ADD COLUMN price_revision integer NOT NULL DEFAULT 1 CHECK(price_revision>0);
    UPDATE products p SET
      price=(SELECT min(price) FROM (
        SELECT price FROM branch_product_prices WHERE product_id=p.id
        UNION ALL SELECT price FROM branch_products WHERE product_id=p.id
      ) agreed),
      price_revision=greatest(1,coalesce((SELECT max(revision) FROM branch_product_prices WHERE product_id=p.id),1));
    ALTER TABLE products ALTER COLUMN price SET NOT NULL, ADD CONSTRAINT products_price_nonnegative CHECK(price>=0);
    ALTER TABLE sales ADD COLUMN inventory_deducted boolean NOT NULL DEFAULT true;
    ALTER TABLE sales ALTER COLUMN inventory_deducted SET DEFAULT false;
  `.execute(db);
}

// `any` is required here since migrations should be frozen in time. alternatively, keep a "snapshot" db interface.
export async function down(db: Kysely<any>): Promise<void> {
  await sql`
    LOCK TABLE products, branch_products, branch_product_prices, sales IN ACCESS EXCLUSIVE MODE;
    DO $$ BEGIN
      IF EXISTS(SELECT 1 FROM sales WHERE NOT inventory_deducted)
        OR EXISTS(SELECT 1 FROM products p WHERE NOT EXISTS(
          SELECT 1 FROM branch_product_prices pr WHERE pr.product_id=p.id AND pr.price=p.price AND pr.revision=p.price_revision
        ))
        OR EXISTS(SELECT 1 FROM products p JOIN branch_product_prices pr ON pr.product_id=p.id WHERE pr.price<>p.price)
      THEN RAISE EXCEPTION 'Global pricing or financial-only sales exist; use a forward correction.'; END IF;
    END $$;
    ALTER TABLE sales DROP COLUMN inventory_deducted;
    ALTER TABLE products DROP COLUMN price, DROP COLUMN price_revision;
  `.execute(db);
}
