import { sql, type Kysely } from 'kysely';
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE supplier_receipts
 ADD COLUMN receipt_kind varchar(24) NOT NULL DEFAULT 'SUPPLIER_DELIVERY',
 ADD COLUMN store_name varchar(160), ADD COLUMN receipt_number varchar(100), ADD COLUMN notes varchar(1000),
 ALTER COLUMN supplier_id DROP NOT NULL,
 ADD CONSTRAINT supplier_receipts_source_valid CHECK (
  (receipt_kind = 'SUPPLIER_DELIVERY' AND supplier_id IS NOT NULL AND store_name IS NULL AND receipt_number IS NULL AND notes IS NULL)
  OR (receipt_kind = 'DIRECT_PURCHASE' AND supplier_id IS NULL)
 )`.execute(db);
  await sql`CREATE INDEX supplier_receipts_kind_date_idx ON supplier_receipts (receipt_kind, received_at DESC, created_at DESC, id DESC)`.execute(
    db,
  );
}
export async function down(db: Kysely<any>): Promise<void> {
  const rows =
    await sql`SELECT 1 FROM supplier_receipts WHERE receipt_kind='DIRECT_PURCHASE' LIMIT 1`.execute(
      db,
    );
  if (rows.rows.length)
    throw new Error(
      'Cannot remove direct purchase history; retain this schema on application rollback.',
    );
  await sql`DROP INDEX supplier_receipts_kind_date_idx`.execute(db);
  await sql`ALTER TABLE supplier_receipts DROP CONSTRAINT supplier_receipts_source_valid, ALTER COLUMN supplier_id SET NOT NULL,
 DROP COLUMN receipt_kind, DROP COLUMN store_name, DROP COLUMN receipt_number, DROP COLUMN notes`.execute(
    db,
  );
}
