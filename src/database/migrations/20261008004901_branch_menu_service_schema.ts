import { sql, type Kysely } from 'kysely';
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    ALTER TABLE branches ADD COLUMN has_takeaway boolean NOT NULL DEFAULT true;
    ALTER TABLE branches ADD CONSTRAINT branches_supported_service CHECK (status <> 'active' OR has_dine_in OR has_takeaway);
    ALTER TABLE products ADD COLUMN service_types text[] NOT NULL DEFAULT ARRAY['DINE_IN','TAKEAWAY'];
    ALTER TABLE products ADD COLUMN recipe_revision integer NOT NULL DEFAULT 0 CHECK (recipe_revision >= 0);
    ALTER TABLE products ADD CONSTRAINT products_service_types CHECK (cardinality(service_types) BETWEEN 1 AND 2 AND service_types <@ ARRAY['DINE_IN','TAKEAWAY']);
    UPDATE products SET recipe_revision = 1 WHERE EXISTS (SELECT 1 FROM product_ingredients WHERE product_id = products.id);
    ALTER TABLE branch_products ADD COLUMN service_types text[] NOT NULL DEFAULT ARRAY['DINE_IN','TAKEAWAY'];
    ALTER TABLE branch_products ADD CONSTRAINT branch_products_service_types CHECK (cardinality(service_types) BETWEEN 1 AND 2 AND service_types <@ ARRAY['DINE_IN','TAKEAWAY']);
    ALTER TABLE product_ingredients ADD COLUMN usage_scope text NOT NULL DEFAULT 'ALL' CHECK (usage_scope IN ('ALL','DINE_IN','TAKEAWAY'));
    ALTER TABLE product_ingredients DROP CONSTRAINT product_ingredients_pk;
    ALTER TABLE product_ingredients ADD PRIMARY KEY (product_id, stock_item_id, usage_scope);
    CREATE TABLE branch_product_prices (
      branch_id uuid NOT NULL REFERENCES branches(id), product_id uuid NOT NULL REFERENCES products(id),
      price numeric NOT NULL CHECK (price >= 0), revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
      updated_by_user_id uuid REFERENCES auth.users(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (branch_id, product_id)
    );
    INSERT INTO branch_product_prices (branch_id,product_id,price,created_at,updated_at)
      SELECT branch_id,product_id,price,created_at,updated_at FROM branch_products;
    ALTER TABLE sales ADD COLUMN service_type text CHECK (service_type IN ('DINE_IN','TAKEAWAY'));
    ALTER TABLE sale_items ADD COLUMN price_revision integer CHECK (price_revision > 0);
    CREATE TABLE menu_requests (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), branch_id uuid NOT NULL REFERENCES branches(id),
      kind text NOT NULL CHECK (kind IN ('NEW_PRODUCT','RECIPE_CHANGE','PRICE_EXCEPTION')),
      status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','CANCELLED')),
      product_id uuid REFERENCES products(id), requested_by_user_id uuid NOT NULL REFERENCES auth.users(id),
      reason text NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500), proposal jsonb NOT NULL, target_snapshot jsonb,
      approved_details jsonb, resulting_product_id uuid REFERENCES products(id), reviewed_by_user_id uuid REFERENCES auth.users(id),
      decision_reason text, revision integer NOT NULL DEFAULT 1, idempotency_key uuid NOT NULL UNIQUE,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      CHECK ((kind = 'NEW_PRODUCT' AND product_id IS NULL) OR (kind <> 'NEW_PRODUCT' AND product_id IS NOT NULL)),
      CHECK (status <> 'APPROVED' OR reviewed_by_user_id <> requested_by_user_id)
    );
    CREATE INDEX menu_requests_branch_status_idx ON menu_requests (branch_id,status,created_at DESC,id);
    CREATE TABLE menu_request_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), request_id uuid NOT NULL REFERENCES menu_requests(id),
      actor_user_id uuid NOT NULL REFERENCES auth.users(id), event_type text NOT NULL CHECK (event_type IN ('SUBMITTED','APPROVED','REJECTED','CANCELLED')),
      reason text, details jsonb, idempotency_key uuid NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE menu_templates (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 160), description text,
      is_active boolean NOT NULL DEFAULT true, revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
      created_by_user_id uuid NOT NULL REFERENCES auth.users(id), updated_by_user_id uuid NOT NULL REFERENCES auth.users(id),
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE menu_template_items (
      template_id uuid NOT NULL REFERENCES menu_templates(id), product_id uuid NOT NULL REFERENCES products(id),
      service_types text[] NOT NULL CHECK (cardinality(service_types) BETWEEN 1 AND 2 AND service_types <@ ARRAY['DINE_IN','TAKEAWAY']),
      PRIMARY KEY (template_id,product_id)
    );
    CREATE TABLE menu_template_applications (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), template_id uuid NOT NULL REFERENCES menu_templates(id), branch_id uuid NOT NULL REFERENCES branches(id),
      template_revision integer NOT NULL, actor_user_id uuid NOT NULL REFERENCES auth.users(id),
      preview_token text NOT NULL, result jsonb NOT NULL, idempotency_key uuid NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now()
    );
  `.execute(db);
}
export async function down(db: Kysely<any>): Promise<void> {
  await sql`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM menu_requests) OR EXISTS (SELECT 1 FROM menu_templates)
      OR EXISTS (SELECT 1 FROM sales WHERE service_type IS NOT NULL)
      OR EXISTS (SELECT 1 FROM product_ingredients WHERE usage_scope <> 'ALL')
      OR EXISTS (SELECT 1 FROM products WHERE service_types <> ARRAY['DINE_IN','TAKEAWAY'])
      OR EXISTS (SELECT 1 FROM branch_products WHERE service_types <> ARRAY['DINE_IN','TAKEAWAY'])
      OR EXISTS (SELECT 1 FROM branches WHERE NOT has_takeaway)
      OR EXISTS (SELECT 1 FROM branch_product_prices p WHERE NOT EXISTS (SELECT 1 FROM branch_products b WHERE b.branch_id=p.branch_id AND b.product_id=p.product_id AND b.price=p.price))
    THEN RAISE EXCEPTION 'Menu rollout contains new data; use a forward correction.'; END IF;
  END $$;
  DROP TABLE menu_template_applications, menu_template_items, menu_templates, menu_request_events, menu_requests, branch_product_prices;
  ALTER TABLE sale_items DROP COLUMN price_revision;
  ALTER TABLE sales DROP COLUMN service_type;
  ALTER TABLE product_ingredients DROP CONSTRAINT product_ingredients_pkey;
  ALTER TABLE product_ingredients DROP COLUMN usage_scope;
  ALTER TABLE product_ingredients ADD CONSTRAINT product_ingredients_pk PRIMARY KEY (product_id,stock_item_id);
  ALTER TABLE branch_products DROP CONSTRAINT branch_products_service_types, DROP COLUMN service_types;
  ALTER TABLE products DROP CONSTRAINT products_service_types, DROP COLUMN service_types, DROP COLUMN recipe_revision;
  ALTER TABLE branches DROP CONSTRAINT branches_supported_service, DROP COLUMN has_takeaway;`.execute(
    db,
  );
}
