import { sql, type Kysely } from 'kysely';

// `any` is required here since migrations must remain frozen in time.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('daily_branch_reports')
    .addColumn('id', 'uuid', (column) =>
      column.primaryKey().defaultTo(db.fn('gen_random_uuid')),
    )
    .addColumn('branch_id', 'uuid', (column) =>
      column.notNull().references('branches.id').onDelete('restrict'),
    )
    .addColumn('business_date', 'date', (column) => column.notNull())
    .addColumn('status', 'varchar(16)', (column) =>
      column.notNull().defaultTo('DRAFT'),
    )
    .addColumn('idempotency_key', 'uuid', (column) => column.notNull())
    .addColumn('created_by_user_id', 'uuid', (column) =>
      column.notNull().references('auth.users.id').onDelete('restrict'),
    )
    .addColumn('submitted_by_user_id', 'uuid', (column) =>
      column.references('auth.users.id').onDelete('restrict'),
    )
    .addColumn('submitted_at', 'timestamptz')
    .addColumn('reviewed_by_user_id', 'uuid', (column) =>
      column.references('auth.users.id').onDelete('restrict'),
    )
    .addColumn('reviewed_at', 'timestamptz')
    .addColumn('return_reason', 'text')
    .addColumn('created_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(db.fn('now')),
    )
    .addColumn('updated_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(db.fn('now')),
    )
    .addUniqueConstraint('daily_branch_reports_branch_date_unique', [
      'branch_id',
      'business_date',
    ])
    .addUniqueConstraint('daily_branch_reports_idempotency_key_unique', [
      'idempotency_key',
    ])
    .addCheckConstraint(
      'daily_branch_reports_status_payload_valid',
      sql`(status = 'DRAFT' AND submitted_by_user_id IS NULL AND submitted_at IS NULL AND reviewed_by_user_id IS NULL AND reviewed_at IS NULL AND return_reason IS NULL)
        OR (status = 'SUBMITTED' AND submitted_by_user_id IS NOT NULL AND submitted_at IS NOT NULL AND reviewed_by_user_id IS NULL AND reviewed_at IS NULL AND return_reason IS NULL)
        OR (status = 'RETURNED' AND submitted_by_user_id IS NOT NULL AND submitted_at IS NOT NULL AND reviewed_by_user_id IS NOT NULL AND reviewed_at IS NOT NULL AND return_reason IS NOT NULL AND char_length(btrim(return_reason)) > 0)
        OR (status = 'APPROVED' AND submitted_by_user_id IS NOT NULL AND submitted_at IS NOT NULL AND reviewed_by_user_id IS NOT NULL AND reviewed_at IS NOT NULL AND return_reason IS NULL)`,
    )
    .execute();

  await db.schema
    .createIndex('daily_branch_reports_branch_status_date_idx')
    .on('daily_branch_reports')
    .columns(['branch_id', 'status', 'business_date', 'id'])
    .execute();

  await db.schema
    .createTable('daily_branch_report_items')
    .addColumn('id', 'uuid', (column) =>
      column.primaryKey().defaultTo(db.fn('gen_random_uuid')),
    )
    .addColumn('daily_branch_report_id', 'uuid', (column) =>
      column
        .notNull()
        .references('daily_branch_reports.id')
        .onDelete('restrict'),
    )
    .addColumn('stock_item_id', 'uuid', (column) =>
      column.notNull().references('stock_items.id').onDelete('restrict'),
    )
    .addColumn('opening_quantity', 'numeric', (column) => column.notNull())
    .addColumn('receipt_quantity', 'numeric', (column) => column.notNull())
    .addColumn('sale_consumption_quantity', 'numeric', (column) =>
      column.notNull(),
    )
    .addColumn('sale_void_reversal_quantity', 'numeric', (column) =>
      column.notNull(),
    )
    .addColumn('ledger_adjustment_quantity', 'numeric', (column) =>
      column.notNull(),
    )
    .addColumn('ledger_closing_quantity', 'numeric', (column) =>
      column.notNull(),
    )
    .addColumn('waste_quantity', 'numeric', (column) =>
      column.notNull().defaultTo(0),
    )
    .addColumn('waste_reason', 'text')
    .addColumn('adjustment_quantity', 'numeric', (column) =>
      column.notNull().defaultTo(0),
    )
    .addColumn('adjustment_reason', 'text')
    .addColumn('expected_closing_quantity', 'numeric', (column) =>
      column.notNull(),
    )
    .addColumn('physical_closing_quantity', 'numeric')
    .addColumn('variance_quantity', 'numeric')
    .addColumn('created_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(db.fn('now')),
    )
    .addColumn('updated_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(db.fn('now')),
    )
    .addUniqueConstraint('daily_branch_report_items_report_stock_unique', [
      'daily_branch_report_id',
      'stock_item_id',
    ])
    .addCheckConstraint(
      'daily_branch_report_items_nonnegative_inputs',
      sql`opening_quantity >= 0 AND receipt_quantity >= 0 AND sale_consumption_quantity >= 0 AND sale_void_reversal_quantity >= 0 AND ledger_closing_quantity >= 0 AND waste_quantity >= 0 AND (physical_closing_quantity IS NULL OR physical_closing_quantity >= 0)`,
    )
    .addCheckConstraint(
      'daily_branch_report_items_expected_matches',
      sql`expected_closing_quantity = ledger_closing_quantity - waste_quantity + adjustment_quantity`,
    )
    .addCheckConstraint(
      'daily_branch_report_items_variance_matches',
      sql`(physical_closing_quantity IS NULL AND variance_quantity IS NULL) OR (physical_closing_quantity IS NOT NULL AND variance_quantity = physical_closing_quantity - expected_closing_quantity)`,
    )
    .addCheckConstraint(
      'daily_branch_report_items_waste_reason_valid',
      sql`(waste_quantity = 0 AND waste_reason IS NULL) OR (waste_quantity > 0 AND waste_reason IS NOT NULL AND char_length(btrim(waste_reason)) > 0)`,
    )
    .addCheckConstraint(
      'daily_branch_report_items_adjustment_reason_valid',
      sql`(adjustment_quantity = 0 AND adjustment_reason IS NULL) OR (adjustment_quantity <> 0 AND adjustment_reason IS NOT NULL AND char_length(btrim(adjustment_reason)) > 0)`,
    )
    .execute();

  await db.schema
    .createTable('daily_branch_report_events')
    .addColumn('id', 'uuid', (column) =>
      column.primaryKey().defaultTo(db.fn('gen_random_uuid')),
    )
    .addColumn('daily_branch_report_id', 'uuid', (column) =>
      column
        .notNull()
        .references('daily_branch_reports.id')
        .onDelete('restrict'),
    )
    .addColumn('event_type', 'varchar(16)', (column) => column.notNull())
    .addColumn('actor_user_id', 'uuid', (column) =>
      column.notNull().references('auth.users.id').onDelete('restrict'),
    )
    .addColumn('note', 'text')
    .addColumn('created_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(db.fn('now')),
    )
    .addCheckConstraint(
      'daily_branch_report_events_type_valid',
      sql`event_type IN ('CREATED', 'UPDATED', 'SUBMITTED', 'RETURNED', 'APPROVED')`,
    )
    .addCheckConstraint(
      'daily_branch_report_events_return_note_required',
      sql`event_type <> 'RETURNED' OR (note IS NOT NULL AND char_length(btrim(note)) > 0)`,
    )
    .execute();

  await db.schema
    .createIndex('daily_branch_report_events_report_created_idx')
    .on('daily_branch_report_events')
    .columns(['daily_branch_report_id', 'created_at', 'id'])
    .execute();

  await db.schema
    .alterTable('inventory_movements')
    .addColumn('daily_branch_report_item_id', 'uuid', (column) =>
      column.references('daily_branch_report_items.id').onDelete('restrict'),
    )
    .execute();

  await db.schema
    .createIndex('inventory_movements_daily_report_item_unique')
    .unique()
    .on('inventory_movements')
    .column('daily_branch_report_item_id')
    .execute();

  await sql`
    ALTER TABLE inventory_movements
    ADD CONSTRAINT inventory_movements_daily_report_source_valid CHECK (
      (movement_type = 'REPORT_ADJUSTMENT' AND daily_branch_report_item_id IS NOT NULL)
      OR (movement_type <> 'REPORT_ADJUSTMENT' AND daily_branch_report_item_id IS NULL)
    )
  `.execute(db);
}

// `any` is required here since migrations must remain frozen in time.
export async function down(db: Kysely<any>): Promise<void> {
  await sql`
    ALTER TABLE inventory_movements
    DROP CONSTRAINT IF EXISTS inventory_movements_daily_report_source_valid
  `.execute(db);
  await db.schema
    .dropIndex('inventory_movements_daily_report_item_unique')
    .ifExists()
    .execute();
  await db.schema
    .alterTable('inventory_movements')
    .dropColumn('daily_branch_report_item_id')
    .execute();
  await db.schema
    .dropIndex('daily_branch_report_events_report_created_idx')
    .ifExists()
    .execute();
  await db.schema
    .dropIndex('daily_branch_reports_branch_status_date_idx')
    .ifExists()
    .execute();
  await db.schema.dropTable('daily_branch_report_events').ifExists().execute();
  await db.schema.dropTable('daily_branch_report_items').ifExists().execute();
  await db.schema.dropTable('daily_branch_reports').ifExists().execute();
}
