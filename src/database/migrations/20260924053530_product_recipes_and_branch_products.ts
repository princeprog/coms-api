import { sql, type Kysely } from 'kysely';

// `any` is required here since migrations should be frozen in time. alternatively, keep a "snapshot" db interface.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('product_ingredients')
    .addColumn('product_id', 'uuid', (column) =>
      column.notNull().references('products.id').onDelete('restrict'),
    )
    .addColumn('stock_item_id', 'uuid', (column) =>
      column.notNull().references('stock_items.id').onDelete('restrict'),
    )
    .addColumn('quantity_required', 'numeric', (column) => column.notNull())
    .addColumn('created_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(db.fn('now')),
    )
    .addColumn('updated_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(db.fn('now')),
    )
    .addPrimaryKeyConstraint('product_ingredients_pk', [
      'product_id',
      'stock_item_id',
    ])
    .addCheckConstraint(
      'product_ingredients_quantity_positive',
      sql`quantity_required > 0`,
    )
    .execute();

  await db.schema
    .createIndex('product_ingredients_stock_item_id_idx')
    .on('product_ingredients')
    .column('stock_item_id')
    .execute();

  await db.schema
    .createTable('branch_products')
    .addColumn('branch_id', 'uuid', (column) =>
      column.notNull().references('branches.id').onDelete('restrict'),
    )
    .addColumn('product_id', 'uuid', (column) =>
      column.notNull().references('products.id').onDelete('restrict'),
    )
    .addColumn('price', 'numeric', (column) => column.notNull())
    .addColumn('is_available', 'boolean', (column) =>
      column.notNull().defaultTo(true),
    )
    .addColumn('created_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(db.fn('now')),
    )
    .addColumn('updated_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(db.fn('now')),
    )
    .addPrimaryKeyConstraint('branch_products_pk', ['branch_id', 'product_id'])
    .addCheckConstraint('branch_products_price_nonnegative', sql`price >= 0`)
    .execute();

  await db.schema
    .createIndex('branch_products_product_id_idx')
    .on('branch_products')
    .column('product_id')
    .execute();
}

// `any` is required here since migrations should be frozen in time. alternatively, keep a "snapshot" db interface.
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('branch_products').ifExists().execute();
  await db.schema.dropTable('product_ingredients').ifExists().execute();
}
