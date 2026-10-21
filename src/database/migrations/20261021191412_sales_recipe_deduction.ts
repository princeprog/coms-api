import { sql, type Kysely } from 'kysely';

// Recipe deduction never blocks a sale, so branch balances (and the report
// snapshots derived from them) may go below zero until a physical count corrects
// them. Commissary stock keeps its non-negative guarantee.
// `any` is required here since migrations should be frozen in time.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    ALTER TABLE branch_inventory DROP CONSTRAINT branch_inventory_quantity_nonnegative;
    ALTER TABLE daily_branch_report_items DROP CONSTRAINT daily_branch_report_items_nonnegative_inputs;
    ALTER TABLE daily_branch_report_items ADD CONSTRAINT daily_branch_report_items_nonnegative_inputs CHECK (
      receipt_quantity >= 0 AND sale_consumption_quantity >= 0 AND sale_void_reversal_quantity >= 0
      AND waste_quantity >= 0 AND (physical_closing_quantity IS NULL OR physical_closing_quantity >= 0)
    );
  `.execute(db);
}

// `any` is required here since migrations should be frozen in time.
export async function down(db: Kysely<any>): Promise<void> {
  await sql`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM branch_inventory WHERE quantity_on_hand < 0)
      OR EXISTS (SELECT 1 FROM daily_branch_report_items WHERE opening_quantity < 0 OR ledger_closing_quantity < 0)
    THEN RAISE EXCEPTION 'Negative branch stock exists; correct it with a forward change before rolling back.'; END IF;
    END $$;
    ALTER TABLE daily_branch_report_items DROP CONSTRAINT daily_branch_report_items_nonnegative_inputs;
    ALTER TABLE daily_branch_report_items ADD CONSTRAINT daily_branch_report_items_nonnegative_inputs CHECK (
      opening_quantity >= 0 AND receipt_quantity >= 0 AND sale_consumption_quantity >= 0
      AND sale_void_reversal_quantity >= 0 AND ledger_closing_quantity >= 0 AND waste_quantity >= 0
      AND (physical_closing_quantity IS NULL OR physical_closing_quantity >= 0)
    );
    ALTER TABLE branch_inventory ADD CONSTRAINT branch_inventory_quantity_nonnegative CHECK (quantity_on_hand >= 0);
  `.execute(db);
}
