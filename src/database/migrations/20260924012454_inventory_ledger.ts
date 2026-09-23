import { sql, type Kysely } from 'kysely';

// `any` is required here since migrations should be frozen in time. alternatively, keep a "snapshot" db interface.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('commissary_inventory')
    .addColumn('stock_item_id', 'uuid', (column) =>
      column.primaryKey().references('stock_items.id').onDelete('restrict'),
    )
    .addColumn('quantity_on_hand', 'numeric', (column) =>
      column.notNull().defaultTo(0),
    )
    .addColumn('updated_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(db.fn('now')),
    )
    .addCheckConstraint(
      'commissary_inventory_quantity_nonnegative',
      sql`quantity_on_hand >= 0`,
    )
    .execute();

  await db.schema
    .createTable('branch_inventory')
    .addColumn('branch_id', 'uuid', (column) =>
      column.notNull().references('branches.id').onDelete('restrict'),
    )
    .addColumn('stock_item_id', 'uuid', (column) =>
      column.notNull().references('stock_items.id').onDelete('restrict'),
    )
    .addColumn('quantity_on_hand', 'numeric', (column) =>
      column.notNull().defaultTo(0),
    )
    .addColumn('updated_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(db.fn('now')),
    )
    .addPrimaryKeyConstraint('branch_inventory_pkey', [
      'branch_id',
      'stock_item_id',
    ])
    .addCheckConstraint(
      'branch_inventory_quantity_nonnegative',
      sql`quantity_on_hand >= 0`,
    )
    .execute();

  await db.schema
    .createTable('inventory_movements')
    .addColumn('id', 'uuid', (column) =>
      column.primaryKey().defaultTo(db.fn('gen_random_uuid')),
    )
    .addColumn('inventory_scope', 'varchar(16)', (column) => column.notNull())
    .addColumn('branch_id', 'uuid', (column) =>
      column.references('branches.id').onDelete('restrict'),
    )
    .addColumn('stock_item_id', 'uuid', (column) =>
      column.notNull().references('stock_items.id').onDelete('restrict'),
    )
    .addColumn('movement_type', 'varchar(32)', (column) => column.notNull())
    .addColumn('quantity_delta', 'numeric', (column) => column.notNull())
    .addColumn('reason', 'text')
    .addColumn('actor_user_id', 'uuid', (column) =>
      column.notNull().references('auth.users.id').onDelete('restrict'),
    )
    .addColumn('idempotency_key', 'uuid')
    .addColumn('created_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(db.fn('now')),
    )
    .addCheckConstraint(
      'inventory_movements_scope_valid',
      sql`inventory_scope IN ('COMMISSARY', 'BRANCH')`,
    )
    .addCheckConstraint(
      'inventory_movements_scope_branch_consistent',
      sql`(inventory_scope = 'COMMISSARY' AND branch_id IS NULL) OR (inventory_scope = 'BRANCH' AND branch_id IS NOT NULL)`,
    )
    .addCheckConstraint(
      'inventory_movements_type_valid',
      sql`movement_type IN ('RECEIPT', 'ADJUSTMENT', 'DISPATCH', 'TRANSFER_IN', 'SALE', 'SALE_VOID', 'REPORT_ADJUSTMENT')`,
    )
    .addCheckConstraint(
      'inventory_movements_nonzero_delta',
      sql`quantity_delta <> 0`,
    )
    .addCheckConstraint(
      'inventory_movements_reason_required',
      sql`movement_type NOT IN ('ADJUSTMENT', 'SALE_VOID', 'REPORT_ADJUSTMENT') OR (reason IS NOT NULL AND char_length(btrim(reason)) > 0)`,
    )
    .addUniqueConstraint('inventory_movements_idempotency_key_unique', [
      'idempotency_key',
    ])
    .execute();

  await db.schema
    .createIndex('inventory_movements_scope_item_created_idx')
    .on('inventory_movements')
    .columns(['inventory_scope', 'branch_id', 'stock_item_id', 'created_at'])
    .execute();
}

// `any` is required here since migrations should be frozen in time. alternatively, keep a "snapshot" db interface.
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('inventory_movements').ifExists().execute();
  await db.schema.dropTable('branch_inventory').ifExists().execute();
  await db.schema.dropTable('commissary_inventory').ifExists().execute();
}
