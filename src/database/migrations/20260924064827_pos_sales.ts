import { sql, type Kysely } from 'kysely';

// `any` is required here since migrations should be frozen in time. alternatively, keep a "snapshot" db interface.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('sales')
    .addColumn('id', 'uuid', (column) =>
      column.primaryKey().defaultTo(db.fn('gen_random_uuid')),
    )
    .addColumn('branch_id', 'uuid', (column) =>
      column.notNull().references('branches.id').onDelete('restrict'),
    )
    .addColumn('cashier_user_id', 'uuid', (column) =>
      column.notNull().references('auth.users.id').onDelete('restrict'),
    )
    .addColumn('status', 'varchar(16)', (column) => column.notNull())
    .addColumn('tender_method', 'varchar(40)', (column) => column.notNull())
    .addColumn('total_amount', 'numeric', (column) => column.notNull())
    .addColumn('idempotency_key', 'uuid', (column) => column.notNull())
    .addColumn('created_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(db.fn('now')),
    )
    .addUniqueConstraint('sales_idempotency_key_unique', ['idempotency_key'])
    .addCheckConstraint(
      'sales_status_valid',
      sql`status IN ('COMPLETED', 'VOIDED')`,
    )
    .addCheckConstraint('sales_total_nonnegative', sql`total_amount >= 0`)
    .addCheckConstraint(
      'sales_tender_method_nonblank',
      sql`char_length(btrim(tender_method)) > 0`,
    )
    .execute();

  await db.schema
    .createIndex('sales_branch_created_id_idx')
    .on('sales')
    .columns(['branch_id', 'created_at', 'id'])
    .execute();

  await db.schema
    .createTable('sale_items')
    .addColumn('id', 'uuid', (column) =>
      column.primaryKey().defaultTo(db.fn('gen_random_uuid')),
    )
    .addColumn('sale_id', 'uuid', (column) =>
      column.notNull().references('sales.id').onDelete('restrict'),
    )
    .addColumn('product_id', 'uuid', (column) =>
      column.notNull().references('products.id').onDelete('restrict'),
    )
    .addColumn('product_name_snapshot', 'varchar(160)', (column) =>
      column.notNull(),
    )
    .addColumn('quantity', 'numeric', (column) => column.notNull())
    .addColumn('unit_price', 'numeric', (column) => column.notNull())
    .addColumn('line_total', 'numeric', (column) => column.notNull())
    .addColumn('created_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(db.fn('now')),
    )
    .addUniqueConstraint('sale_items_sale_product_unique', [
      'sale_id',
      'product_id',
    ])
    .addCheckConstraint('sale_items_quantity_positive', sql`quantity > 0`)
    .addCheckConstraint(
      'sale_items_unit_price_nonnegative',
      sql`unit_price >= 0`,
    )
    .addCheckConstraint(
      'sale_items_line_total_nonnegative',
      sql`line_total >= 0`,
    )
    .addCheckConstraint(
      'sale_items_line_total_matches',
      sql`line_total = quantity * unit_price`,
    )
    .addCheckConstraint(
      'sale_items_product_snapshot_nonblank',
      sql`char_length(btrim(product_name_snapshot)) > 0`,
    )
    .execute();

  await db.schema
    .createIndex('sale_items_sale_id_idx')
    .on('sale_items')
    .column('sale_id')
    .execute();

  await db.schema
    .createTable('sale_item_consumptions')
    .addColumn('id', 'uuid', (column) =>
      column.primaryKey().defaultTo(db.fn('gen_random_uuid')),
    )
    .addColumn('sale_item_id', 'uuid', (column) =>
      column.notNull().references('sale_items.id').onDelete('restrict'),
    )
    .addColumn('stock_item_id', 'uuid', (column) =>
      column.notNull().references('stock_items.id').onDelete('restrict'),
    )
    .addColumn('quantity_consumed', 'numeric', (column) => column.notNull())
    .addColumn('created_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(db.fn('now')),
    )
    .addUniqueConstraint('sale_item_consumptions_sale_stock_unique', [
      'sale_item_id',
      'stock_item_id',
    ])
    .addCheckConstraint(
      'sale_item_consumptions_quantity_positive',
      sql`quantity_consumed > 0`,
    )
    .execute();

  await db.schema
    .createIndex('sale_item_consumptions_stock_item_id_idx')
    .on('sale_item_consumptions')
    .column('stock_item_id')
    .execute();

  await db.schema
    .createTable('sale_events')
    .addColumn('id', 'uuid', (column) =>
      column.primaryKey().defaultTo(db.fn('gen_random_uuid')),
    )
    .addColumn('sale_id', 'uuid', (column) =>
      column.notNull().references('sales.id').onDelete('restrict'),
    )
    .addColumn('event_type', 'varchar(16)', (column) => column.notNull())
    .addColumn('actor_user_id', 'uuid', (column) =>
      column.notNull().references('auth.users.id').onDelete('restrict'),
    )
    .addColumn('reason', 'text')
    .addColumn('idempotency_key', 'uuid')
    .addColumn('created_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(db.fn('now')),
    )
    .addUniqueConstraint('sale_events_sale_type_unique', [
      'sale_id',
      'event_type',
    ])
    .addUniqueConstraint('sale_events_idempotency_key_unique', [
      'idempotency_key',
    ])
    .addCheckConstraint(
      'sale_events_type_valid',
      sql`event_type IN ('COMPLETED', 'VOIDED')`,
    )
    .addCheckConstraint(
      'sale_events_payload_valid',
      sql`(event_type = 'COMPLETED' AND reason IS NULL AND idempotency_key IS NULL) OR (event_type = 'VOIDED' AND reason IS NOT NULL AND char_length(btrim(reason)) > 0 AND idempotency_key IS NOT NULL)`,
    )
    .execute();

  await db.schema
    .alterTable('inventory_movements')
    .addColumn('sale_item_consumption_id', 'uuid', (column) =>
      column.references('sale_item_consumptions.id').onDelete('restrict'),
    )
    .addColumn('reversal_of_movement_id', 'uuid', (column) =>
      column.references('inventory_movements.id').onDelete('restrict'),
    )
    .execute();

  await sql`
    ALTER TABLE inventory_movements
    ADD CONSTRAINT inventory_movements_sale_source_valid CHECK (
      (movement_type = 'SALE' AND sale_item_consumption_id IS NOT NULL AND reversal_of_movement_id IS NULL)
      OR (movement_type = 'SALE_VOID' AND sale_item_consumption_id IS NULL AND reversal_of_movement_id IS NOT NULL)
      OR (movement_type NOT IN ('SALE', 'SALE_VOID') AND sale_item_consumption_id IS NULL AND reversal_of_movement_id IS NULL)
    )
  `.execute(db);

  await db.schema
    .createIndex('inventory_movements_sale_consumption_unique')
    .unique()
    .on('inventory_movements')
    .column('sale_item_consumption_id')
    .execute();

  await db.schema
    .createIndex('inventory_movements_reversal_unique')
    .unique()
    .on('inventory_movements')
    .column('reversal_of_movement_id')
    .execute();
}

// `any` is required here since migrations should be frozen in time. alternatively, keep a "snapshot" db interface.
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .dropIndex('inventory_movements_reversal_unique')
    .ifExists()
    .execute();
  await db.schema
    .dropIndex('inventory_movements_sale_consumption_unique')
    .ifExists()
    .execute();
  await sql`
    ALTER TABLE inventory_movements
    DROP CONSTRAINT IF EXISTS inventory_movements_sale_source_valid
  `.execute(db);
  await db.schema
    .alterTable('inventory_movements')
    .dropColumn('sale_item_consumption_id')
    .dropColumn('reversal_of_movement_id')
    .execute();
  await db.schema.dropTable('sale_events').ifExists().execute();
  await db.schema.dropTable('sale_item_consumptions').ifExists().execute();
  await db.schema.dropTable('sale_items').ifExists().execute();
  await db.schema.dropTable('sales').ifExists().execute();
}
