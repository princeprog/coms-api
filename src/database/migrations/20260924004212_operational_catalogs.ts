import { sql, type Kysely } from 'kysely';

// `any` is required here since migrations should be frozen in time. alternatively, keep a "snapshot" db interface.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('suppliers')
    .addColumn('id', 'uuid', (column) =>
      column.primaryKey().defaultTo(db.fn('gen_random_uuid')),
    )
    .addColumn('supplier_name', 'varchar(160)', (column) => column.notNull())
    .addColumn('contact_person', 'varchar(120)')
    .addColumn('contact_number', 'varchar(32)')
    .addColumn('email', 'varchar(254)')
    .addColumn('address', 'text')
    .addColumn('is_active', 'boolean', (column) =>
      column.notNull().defaultTo(true),
    )
    .addColumn('created_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(db.fn('now')),
    )
    .addColumn('updated_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(db.fn('now')),
    )
    .addCheckConstraint(
      'suppliers_name_nonempty',
      sql`char_length(btrim(supplier_name)) > 0`,
    )
    .execute();

  await db.schema
    .createIndex('suppliers_active_name_idx')
    .on('suppliers')
    .columns(['is_active', 'supplier_name'])
    .execute();

  await db.schema
    .createTable('stock_items')
    .addColumn('id', 'uuid', (column) =>
      column.primaryKey().defaultTo(db.fn('gen_random_uuid')),
    )
    .addColumn('stock_item_name', 'varchar(160)', (column) => column.notNull())
    .addColumn('category', 'varchar(80)', (column) => column.notNull())
    .addColumn('unit', 'varchar(40)', (column) => column.notNull())
    .addColumn('is_active', 'boolean', (column) =>
      column.notNull().defaultTo(true),
    )
    .addColumn('created_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(db.fn('now')),
    )
    .addColumn('updated_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(db.fn('now')),
    )
    .addCheckConstraint(
      'stock_items_name_nonempty',
      sql`char_length(btrim(stock_item_name)) > 0`,
    )
    .addCheckConstraint(
      'stock_items_category_nonempty',
      sql`char_length(btrim(category)) > 0`,
    )
    .addCheckConstraint(
      'stock_items_unit_nonempty',
      sql`char_length(btrim(unit)) > 0`,
    )
    .execute();

  await db.schema
    .createIndex('stock_items_active_name_idx')
    .on('stock_items')
    .columns(['is_active', 'stock_item_name'])
    .execute();

  await db.schema
    .createTable('products')
    .addColumn('id', 'uuid', (column) =>
      column.primaryKey().defaultTo(db.fn('gen_random_uuid')),
    )
    .addColumn('product_name', 'varchar(160)', (column) => column.notNull())
    .addColumn('description', 'text')
    .addColumn('is_active', 'boolean', (column) =>
      column.notNull().defaultTo(true),
    )
    .addColumn('created_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(db.fn('now')),
    )
    .addColumn('updated_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(db.fn('now')),
    )
    .addCheckConstraint(
      'products_name_nonempty',
      sql`char_length(btrim(product_name)) > 0`,
    )
    .execute();

  await db.schema
    .createIndex('products_active_name_idx')
    .on('products')
    .columns(['is_active', 'product_name'])
    .execute();
}

// `any` is required here since migrations should be frozen in time. alternatively, keep a "snapshot" db interface.
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('products').ifExists().execute();
  await db.schema.dropTable('stock_items').ifExists().execute();
  await db.schema.dropTable('suppliers').ifExists().execute();
}
