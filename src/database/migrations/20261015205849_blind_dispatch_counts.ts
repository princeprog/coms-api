import { sql, type Kysely } from 'kysely';

// `any` keeps this migration frozen against the schema version it changes.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    ALTER TABLE dispatches
      ADD COLUMN delivered_by_name varchar(120),
      ADD COLUMN counted_at timestamptz,
      ADD COLUMN counted_by_user_id uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
      ADD CONSTRAINT dispatches_delivered_by_name_nonblank
        CHECK (delivered_by_name IS NULL OR char_length(btrim(delivered_by_name)) BETWEEN 1 AND 120),
      ADD CONSTRAINT dispatches_count_actor_consistent
        CHECK ((counted_at IS NULL) = (counted_by_user_id IS NULL))
  `.execute(db);

  await sql`
    ALTER TABLE dispatch_receipts
      ADD COLUMN note text,
      ADD CONSTRAINT dispatch_receipts_note_length
        CHECK (note IS NULL OR char_length(btrim(note)) BETWEEN 1 AND 500)
  `.execute(db);

  // A blind count records zero for items that did not arrive.
  await sql`
    ALTER TABLE dispatch_receipt_items
      DROP CONSTRAINT dispatch_receipt_items_quantity_positive,
      ADD CONSTRAINT dispatch_receipt_items_quantity_nonnegative
        CHECK (quantity_received >= 0)
  `.execute(db);

  await sql`
    ALTER TABLE dispatch_shortage_closures
      ADD COLUMN outcome varchar(16) NOT NULL DEFAULT 'LOST',
      ADD CONSTRAINT dispatch_shortage_closures_outcome_valid
        CHECK (outcome IN ('LOST', 'NOT_LOADED', 'SURPLUS'))
  `.execute(db);

  await sql`
    ALTER TABLE inventory_movements
      ADD COLUMN dispatch_shortage_closure_item_id uuid
        REFERENCES dispatch_shortage_closure_items(id) ON DELETE RESTRICT,
      ADD CONSTRAINT inventory_movements_dispatch_resolution_unique
        UNIQUE (dispatch_shortage_closure_item_id),
      DROP CONSTRAINT inventory_movements_type_valid,
      ADD CONSTRAINT inventory_movements_type_valid
        CHECK (movement_type IN ('RECEIPT', 'ADJUSTMENT', 'DISPATCH', 'DISPATCH_RETURN', 'TRANSFER_IN', 'SALE', 'SALE_VOID', 'REPORT_ADJUSTMENT')),
      ADD CONSTRAINT inventory_movements_dispatch_resolution_consistent
        CHECK (
          (dispatch_shortage_closure_item_id IS NULL AND movement_type <> 'DISPATCH_RETURN')
          OR (dispatch_shortage_closure_item_id IS NOT NULL
            AND inventory_scope = 'COMMISSARY' AND branch_id IS NULL
            AND dispatch_item_id IS NULL AND dispatch_receipt_item_id IS NULL
            AND ((movement_type = 'DISPATCH_RETURN' AND quantity_delta > 0)
              OR (movement_type = 'DISPATCH' AND quantity_delta < 0)))
        )
  `.execute(db);
}

// `any` keeps this migration frozen against the schema version it changes.
export async function down(db: Kysely<any>): Promise<void> {
  const usage = await sql<{ blocked: boolean }>`
    SELECT
      EXISTS (SELECT 1 FROM dispatch_receipt_items WHERE quantity_received = 0)
      OR EXISTS (SELECT 1 FROM dispatch_shortage_closures WHERE outcome <> 'LOST')
      OR EXISTS (SELECT 1 FROM inventory_movements WHERE dispatch_shortage_closure_item_id IS NOT NULL)
      OR EXISTS (SELECT 1 FROM dispatches WHERE counted_at IS NOT NULL OR delivered_by_name IS NOT NULL)
      OR EXISTS (SELECT 1 FROM dispatch_receipts WHERE note IS NOT NULL)
      AS blocked
  `.execute(db);
  if (usage.rows[0]?.blocked)
    throw new Error(
      'Cannot roll back blind dispatch counts while counted dispatches, delivery names, count notes, zero counts, or variance resolutions exist.',
    );

  await sql`
    ALTER TABLE inventory_movements
      DROP CONSTRAINT inventory_movements_dispatch_resolution_consistent,
      DROP CONSTRAINT inventory_movements_type_valid,
      ADD CONSTRAINT inventory_movements_type_valid
        CHECK (movement_type IN ('RECEIPT', 'ADJUSTMENT', 'DISPATCH', 'TRANSFER_IN', 'SALE', 'SALE_VOID', 'REPORT_ADJUSTMENT')),
      DROP CONSTRAINT inventory_movements_dispatch_resolution_unique,
      DROP COLUMN dispatch_shortage_closure_item_id
  `.execute(db);
  await sql`
    ALTER TABLE dispatch_shortage_closures
      DROP CONSTRAINT dispatch_shortage_closures_outcome_valid,
      DROP COLUMN outcome
  `.execute(db);
  await sql`
    ALTER TABLE dispatch_receipt_items
      DROP CONSTRAINT dispatch_receipt_items_quantity_nonnegative,
      ADD CONSTRAINT dispatch_receipt_items_quantity_positive
        CHECK (quantity_received > 0)
  `.execute(db);
  await sql`
    ALTER TABLE dispatch_receipts
      DROP CONSTRAINT dispatch_receipts_note_length,
      DROP COLUMN note
  `.execute(db);
  await sql`
    ALTER TABLE dispatches
      DROP CONSTRAINT dispatches_count_actor_consistent,
      DROP CONSTRAINT dispatches_delivered_by_name_nonblank,
      DROP COLUMN counted_by_user_id,
      DROP COLUMN counted_at,
      DROP COLUMN delivered_by_name
  `.execute(db);
}
