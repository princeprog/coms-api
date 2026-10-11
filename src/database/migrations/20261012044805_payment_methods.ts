import { sql, type Kysely } from 'kysely';

// Migrations describe the schema at this point in time.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE payment_methods (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name varchar(40) NOT NULL CHECK (name = btrim(name) AND length(name) > 0),
      kind text NOT NULL CHECK (kind IN ('CASH', 'NON_CASH')),
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX payment_methods_name_unique ON payment_methods (lower(name));
    INSERT INTO payment_methods (name, kind) VALUES ('Cash', 'CASH');
    ALTER TABLE sales ADD COLUMN payment_method_id uuid REFERENCES payment_methods(id);
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM sales WHERE payment_method_id IS NOT NULL)
        OR EXISTS (SELECT 1 FROM payment_methods WHERE name <> 'Cash' OR kind <> 'CASH' OR NOT is_active OR updated_at <> created_at)
      THEN RAISE EXCEPTION 'Payment methods are in use; preserve their data and use a forward migration';
      END IF;
    END $$;
    ALTER TABLE sales DROP COLUMN payment_method_id;
    DROP TABLE payment_methods;
  `.execute(db);
}
