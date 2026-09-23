import { sql, type Kysely } from 'kysely';

// `any` is required here since migrations should be frozen in time. alternatively, keep a "snapshot" db interface.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('dispatches')
    .addColumn('id', 'uuid', (column) =>
      column.primaryKey().defaultTo(db.fn('gen_random_uuid')),
    )
    .addColumn('stock_request_id', 'uuid', (column) =>
      column
        .notNull()
        .unique()
        .references('stock_requests.id')
        .onDelete('restrict'),
    )
    .addColumn('branch_id', 'uuid', (column) =>
      column.notNull().references('branches.id').onDelete('restrict'),
    )
    .addColumn('status', 'varchar(24)', (column) =>
      column.notNull().defaultTo('DRAFT'),
    )
    .addColumn('idempotency_key', 'uuid', (column) => column.notNull().unique())
    .addColumn('created_by_user_id', 'uuid', (column) =>
      column.notNull().references('auth.users.id').onDelete('restrict'),
    )
    .addColumn('dispatched_by_user_id', 'uuid', (column) =>
      column.references('auth.users.id').onDelete('restrict'),
    )
    .addColumn('dispatched_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(db.fn('now')),
    )
    .addColumn('updated_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(db.fn('now')),
    )
    .addCheckConstraint(
      'dispatches_status_valid',
      sql`status IN ('DRAFT', 'IN_TRANSIT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED_WITH_SHORTAGE')`,
    )
    .addCheckConstraint(
      'dispatches_posting_actor_consistent',
      sql`(status = 'DRAFT' AND dispatched_by_user_id IS NULL AND dispatched_at IS NULL) OR (status <> 'DRAFT' AND dispatched_by_user_id IS NOT NULL AND dispatched_at IS NOT NULL)`,
    )
    .execute();

  await db.schema
    .createIndex('dispatches_branch_status_created_idx')
    .on('dispatches')
    .columns(['branch_id', 'status', 'created_at'])
    .execute();

  await db.schema
    .createTable('dispatch_items')
    .addColumn('id', 'uuid', (column) =>
      column.primaryKey().defaultTo(db.fn('gen_random_uuid')),
    )
    .addColumn('dispatch_id', 'uuid', (column) =>
      column.notNull().references('dispatches.id').onDelete('restrict'),
    )
    .addColumn('stock_request_item_id', 'uuid', (column) =>
      column
        .notNull()
        .unique()
        .references('stock_request_items.id')
        .onDelete('restrict'),
    )
    .addColumn('quantity_dispatched', 'numeric', (column) => column.notNull())
    .addColumn('created_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(db.fn('now')),
    )
    .addUniqueConstraint('dispatch_items_dispatch_request_line_unique', [
      'dispatch_id',
      'stock_request_item_id',
    ])
    .addCheckConstraint(
      'dispatch_items_quantity_positive',
      sql`quantity_dispatched > 0`,
    )
    .execute();

  await db.schema
    .createIndex('dispatch_items_dispatch_idx')
    .on('dispatch_items')
    .column('dispatch_id')
    .execute();

  await db.schema
    .createTable('dispatch_receipts')
    .addColumn('id', 'uuid', (column) =>
      column.primaryKey().defaultTo(db.fn('gen_random_uuid')),
    )
    .addColumn('dispatch_id', 'uuid', (column) =>
      column.notNull().references('dispatches.id').onDelete('restrict'),
    )
    .addColumn('received_by_user_id', 'uuid', (column) =>
      column.notNull().references('auth.users.id').onDelete('restrict'),
    )
    .addColumn('idempotency_key', 'uuid', (column) => column.notNull().unique())
    .addColumn('created_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(db.fn('now')),
    )
    .addUniqueConstraint('dispatch_receipts_id_dispatch_unique', [
      'id',
      'dispatch_id',
    ])
    .execute();

  await db.schema
    .createIndex('dispatch_receipts_dispatch_created_idx')
    .on('dispatch_receipts')
    .columns(['dispatch_id', 'created_at'])
    .execute();

  await db.schema
    .createTable('dispatch_receipt_items')
    .addColumn('id', 'uuid', (column) =>
      column.primaryKey().defaultTo(db.fn('gen_random_uuid')),
    )
    .addColumn('dispatch_receipt_id', 'uuid', (column) =>
      column.notNull().references('dispatch_receipts.id').onDelete('restrict'),
    )
    .addColumn('dispatch_item_id', 'uuid', (column) =>
      column.notNull().references('dispatch_items.id').onDelete('restrict'),
    )
    .addColumn('quantity_received', 'numeric', (column) => column.notNull())
    .addColumn('created_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(db.fn('now')),
    )
    .addUniqueConstraint(
      'dispatch_receipt_items_receipt_dispatch_item_unique',
      ['dispatch_receipt_id', 'dispatch_item_id'],
    )
    .addCheckConstraint(
      'dispatch_receipt_items_quantity_positive',
      sql`quantity_received > 0`,
    )
    .execute();

  await db.schema
    .createIndex('dispatch_receipt_items_dispatch_item_idx')
    .on('dispatch_receipt_items')
    .column('dispatch_item_id')
    .execute();

  await db.schema
    .createTable('dispatch_shortage_closures')
    .addColumn('id', 'uuid', (column) =>
      column.primaryKey().defaultTo(db.fn('gen_random_uuid')),
    )
    .addColumn('dispatch_id', 'uuid', (column) =>
      column.notNull().references('dispatches.id').onDelete('restrict'),
    )
    .addColumn('closed_by_user_id', 'uuid', (column) =>
      column.notNull().references('auth.users.id').onDelete('restrict'),
    )
    .addColumn('idempotency_key', 'uuid', (column) => column.notNull().unique())
    .addColumn('reason', 'text', (column) => column.notNull())
    .addColumn('created_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(db.fn('now')),
    )
    .addUniqueConstraint('dispatch_shortage_closures_id_dispatch_unique', [
      'id',
      'dispatch_id',
    ])
    .addCheckConstraint(
      'dispatch_shortage_closures_reason_required',
      sql`char_length(btrim(reason)) BETWEEN 1 AND 500`,
    )
    .execute();

  await db.schema
    .createIndex('dispatch_shortage_closures_dispatch_created_idx')
    .on('dispatch_shortage_closures')
    .columns(['dispatch_id', 'created_at'])
    .execute();

  await db.schema
    .createTable('dispatch_shortage_closure_items')
    .addColumn('id', 'uuid', (column) =>
      column.primaryKey().defaultTo(db.fn('gen_random_uuid')),
    )
    .addColumn('shortage_closure_id', 'uuid', (column) =>
      column
        .notNull()
        .references('dispatch_shortage_closures.id')
        .onDelete('restrict'),
    )
    .addColumn('dispatch_item_id', 'uuid', (column) =>
      column.notNull().references('dispatch_items.id').onDelete('restrict'),
    )
    .addColumn('quantity_closed', 'numeric', (column) => column.notNull())
    .addColumn('created_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(db.fn('now')),
    )
    .addUniqueConstraint(
      'dispatch_shortage_items_closure_dispatch_item_unique',
      ['shortage_closure_id', 'dispatch_item_id'],
    )
    .addCheckConstraint(
      'dispatch_shortage_items_quantity_positive',
      sql`quantity_closed > 0`,
    )
    .execute();

  await db.schema
    .createIndex('dispatch_shortage_items_dispatch_item_idx')
    .on('dispatch_shortage_closure_items')
    .column('dispatch_item_id')
    .execute();

  await db.schema
    .createTable('dispatch_events')
    .addColumn('id', 'uuid', (column) =>
      column.primaryKey().defaultTo(db.fn('gen_random_uuid')),
    )
    .addColumn('dispatch_id', 'uuid', (column) =>
      column.notNull().references('dispatches.id').onDelete('restrict'),
    )
    .addColumn('event_type', 'varchar(24)', (column) => column.notNull())
    .addColumn('actor_user_id', 'uuid', (column) =>
      column.notNull().references('auth.users.id').onDelete('restrict'),
    )
    .addColumn('idempotency_key', 'uuid', (column) => column.notNull().unique())
    .addColumn('dispatch_receipt_id', 'uuid')
    .addColumn('shortage_closure_id', 'uuid')
    .addColumn('created_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(db.fn('now')),
    )
    .addForeignKeyConstraint(
      'dispatch_events_receipt_dispatch_fkey',
      ['dispatch_receipt_id', 'dispatch_id'],
      'dispatch_receipts',
      ['id', 'dispatch_id'],
      (constraint) => constraint.onDelete('restrict'),
    )
    .addForeignKeyConstraint(
      'dispatch_events_shortage_dispatch_fkey',
      ['shortage_closure_id', 'dispatch_id'],
      'dispatch_shortage_closures',
      ['id', 'dispatch_id'],
      (constraint) => constraint.onDelete('restrict'),
    )
    .addCheckConstraint(
      'dispatch_events_type_reference_consistent',
      sql`(event_type IN ('CREATED', 'DISPATCHED') AND dispatch_receipt_id IS NULL AND shortage_closure_id IS NULL) OR (event_type = 'RECEIPT_RECORDED' AND dispatch_receipt_id IS NOT NULL AND shortage_closure_id IS NULL) OR (event_type = 'SHORTAGE_CLOSED' AND dispatch_receipt_id IS NULL AND shortage_closure_id IS NOT NULL)`,
    )
    .execute();

  await db.schema
    .createIndex('dispatch_events_dispatch_created_idx')
    .on('dispatch_events')
    .columns(['dispatch_id', 'created_at', 'id'])
    .execute();

  await db.schema
    .alterTable('inventory_movements')
    .addColumn('dispatch_item_id', 'uuid', (column) =>
      column.references('dispatch_items.id').onDelete('restrict'),
    )
    .addColumn('dispatch_receipt_item_id', 'uuid', (column) =>
      column.references('dispatch_receipt_items.id').onDelete('restrict'),
    )
    .execute();

  await db.schema
    .alterTable('inventory_movements')
    .addUniqueConstraint('inventory_movements_dispatch_item_unique', [
      'dispatch_item_id',
    ])
    .execute();
  await db.schema
    .alterTable('inventory_movements')
    .addUniqueConstraint('inventory_movements_dispatch_receipt_item_unique', [
      'dispatch_receipt_item_id',
    ])
    .execute();
  await db.schema
    .alterTable('inventory_movements')
    .addCheckConstraint(
      'inventory_movements_dispatch_source_consistent',
      sql`(dispatch_item_id IS NULL OR (movement_type = 'DISPATCH' AND inventory_scope = 'COMMISSARY' AND branch_id IS NULL AND quantity_delta < 0 AND dispatch_receipt_item_id IS NULL)) AND (dispatch_receipt_item_id IS NULL OR (movement_type = 'TRANSFER_IN' AND inventory_scope = 'BRANCH' AND branch_id IS NOT NULL AND quantity_delta > 0 AND dispatch_item_id IS NULL))`,
    )
    .execute();
}

// `any` is required here since migrations should be frozen in time. alternatively, keep a "snapshot" db interface.
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('inventory_movements')
    .dropConstraint('inventory_movements_dispatch_source_consistent')
    .execute();
  await db.schema
    .alterTable('inventory_movements')
    .dropConstraint('inventory_movements_dispatch_item_unique')
    .execute();
  await db.schema
    .alterTable('inventory_movements')
    .dropConstraint('inventory_movements_dispatch_receipt_item_unique')
    .execute();
  await db.schema
    .alterTable('inventory_movements')
    .dropColumn('dispatch_item_id')
    .dropColumn('dispatch_receipt_item_id')
    .execute();

  await db.schema.dropTable('dispatch_events').ifExists().execute();
  await db.schema
    .dropTable('dispatch_shortage_closure_items')
    .ifExists()
    .execute();
  await db.schema.dropTable('dispatch_shortage_closures').ifExists().execute();
  await db.schema.dropTable('dispatch_receipt_items').ifExists().execute();
  await db.schema.dropTable('dispatch_receipts').ifExists().execute();
  await db.schema.dropTable('dispatch_items').ifExists().execute();
  await db.schema.dropTable('dispatches').ifExists().execute();
}
