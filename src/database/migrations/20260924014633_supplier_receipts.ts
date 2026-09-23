import { sql, type Kysely } from 'kysely';

// `any` is required here since migrations should be frozen in time. alternatively, keep a "snapshot" db interface.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('supplier_receipts')
    .addColumn('id', 'uuid', (column) =>
      column.primaryKey().defaultTo(db.fn('gen_random_uuid')),
    )
    .addColumn('supplier_id', 'uuid', (column) =>
      column.notNull().references('suppliers.id').onDelete('restrict'),
    )
    .addColumn('received_at', 'date', (column) => column.notNull())
    .addColumn('status', 'varchar(16)', (column) =>
      column.notNull().defaultTo('DRAFT'),
    )
    .addColumn('idempotency_key', 'uuid', (column) => column.notNull().unique())
    .addColumn('created_by_user_id', 'uuid', (column) =>
      column.notNull().references('auth.users.id').onDelete('restrict'),
    )
    .addColumn('posted_by_user_id', 'uuid', (column) =>
      column.references('auth.users.id').onDelete('restrict'),
    )
    .addColumn('posted_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(db.fn('now')),
    )
    .addColumn('updated_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(db.fn('now')),
    )
    .addCheckConstraint(
      'supplier_receipts_status_valid',
      sql`status IN ('DRAFT', 'POSTED')`,
    )
    .addCheckConstraint(
      'supplier_receipts_post_state_consistent',
      sql`(status = 'DRAFT' AND posted_at IS NULL AND posted_by_user_id IS NULL) OR (status = 'POSTED' AND posted_at IS NOT NULL AND posted_by_user_id IS NOT NULL)`,
    )
    .execute();

  await db.schema
    .createIndex('supplier_receipts_supplier_received_at_idx')
    .on('supplier_receipts')
    .columns(['supplier_id', 'received_at'])
    .execute();
  await db.schema
    .createIndex('supplier_receipts_status_received_at_idx')
    .on('supplier_receipts')
    .columns(['status', 'received_at'])
    .execute();

  await db.schema
    .createTable('supplier_receipt_items')
    .addColumn('id', 'uuid', (column) =>
      column.primaryKey().defaultTo(db.fn('gen_random_uuid')),
    )
    .addColumn('supplier_receipt_id', 'uuid', (column) =>
      column.notNull().references('supplier_receipts.id').onDelete('restrict'),
    )
    .addColumn('stock_item_id', 'uuid', (column) =>
      column.notNull().references('stock_items.id').onDelete('restrict'),
    )
    .addColumn('quantity_received', 'numeric', (column) => column.notNull())
    .addColumn('unit_cost', 'numeric', (column) => column.notNull())
    .addColumn('created_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(db.fn('now')),
    )
    .addCheckConstraint(
      'supplier_receipt_items_quantity_positive',
      sql`quantity_received > 0`,
    )
    .addCheckConstraint(
      'supplier_receipt_items_unit_cost_nonnegative',
      sql`unit_cost >= 0`,
    )
    .execute();

  await db.schema
    .createIndex('supplier_receipt_items_receipt_idx')
    .on('supplier_receipt_items')
    .columns(['supplier_receipt_id', 'id'])
    .execute();
  await db.schema
    .createIndex('supplier_receipt_items_stock_item_idx')
    .on('supplier_receipt_items')
    .column('stock_item_id')
    .execute();

  await db.schema
    .alterTable('inventory_movements')
    .addColumn('supplier_receipt_item_id', 'uuid', (column) =>
      column.references('supplier_receipt_items.id').onDelete('restrict'),
    )
    .execute();
  await db.schema
    .alterTable('inventory_movements')
    .addUniqueConstraint('inventory_movements_supplier_receipt_item_unique', [
      'supplier_receipt_item_id',
    ])
    .execute();
}

// `any` is required here since migrations should be frozen in time. alternatively, keep a "snapshot" db interface.
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('inventory_movements')
    .dropConstraint('inventory_movements_supplier_receipt_item_unique')
    .execute();
  await db.schema
    .alterTable('inventory_movements')
    .dropColumn('supplier_receipt_item_id')
    .execute();
  await db.schema.dropTable('supplier_receipt_items').ifExists().execute();
  await db.schema.dropTable('supplier_receipts').ifExists().execute();
}
