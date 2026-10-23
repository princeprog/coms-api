import { sql, type Kysely } from 'kysely';

// `any` is required here since migrations should be frozen in time. alternatively, keep a "snapshot" db interface.
export async function up(db: Kysely<any>): Promise<void> {
  // A confirmed surplus records stock that already left the commissary.
  // Keep the full deficit visible; normal outgoing operations retain their guards.
  await sql`ALTER TABLE commissary_inventory
    DROP CONSTRAINT commissary_inventory_quantity_nonnegative`.execute(db);
}

// `any` is required here since migrations should be frozen in time. alternatively, keep a "snapshot" db interface.
export async function down(db: Kysely<any>): Promise<void> {
  await sql`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM commissary_inventory WHERE quantity_on_hand < 0)
    THEN RAISE EXCEPTION 'Negative commissary stock exists; reconcile it before rolling back.';
    END IF;
    END $$;
    ALTER TABLE commissary_inventory
      ADD CONSTRAINT commissary_inventory_quantity_nonnegative CHECK (quantity_on_hand >= 0);
  `.execute(db);
}
