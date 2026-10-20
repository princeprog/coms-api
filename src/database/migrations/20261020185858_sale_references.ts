import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`LOCK TABLE sales IN ACCESS EXCLUSIVE MODE`.execute(db);
  await sql`ALTER TABLE sales ADD COLUMN sale_number bigint`.execute(db);
  await sql`WITH numbered AS (
    SELECT id, row_number() OVER (ORDER BY created_at, id) AS number FROM sales
  ) UPDATE sales SET sale_number = numbered.number FROM numbered WHERE sales.id = numbered.id`.execute(
    db,
  );
  await sql`CREATE SEQUENCE sales_number_seq OWNED BY sales.sale_number`.execute(
    db,
  );
  await sql`SELECT setval('sales_number_seq', COALESCE(MAX(sale_number), 0) + 1, false) FROM sales`.execute(
    db,
  );
  await sql`ALTER TABLE sales ALTER COLUMN sale_number SET DEFAULT nextval('sales_number_seq'),
    ALTER COLUMN sale_number SET NOT NULL,
    ADD CONSTRAINT sales_number_unique UNIQUE (sale_number)`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE sales DROP COLUMN sale_number`.execute(db);
}
