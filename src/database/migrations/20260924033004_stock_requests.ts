import { sql, type Kysely } from 'kysely';

// `any` is required here since migrations should be frozen in time. alternatively, keep a "snapshot" db interface.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('stock_requests')
    .addColumn('id', 'uuid', (column) =>
      column.primaryKey().defaultTo(db.fn('gen_random_uuid')),
    )
    .addColumn('branch_id', 'uuid', (column) =>
      column.notNull().references('branches.id').onDelete('restrict'),
    )
    .addColumn('requested_by_user_id', 'uuid', (column) =>
      column.notNull().references('auth.users.id').onDelete('restrict'),
    )
    .addColumn('status', 'varchar(16)', (column) =>
      column.notNull().defaultTo('PENDING'),
    )
    .addColumn('idempotency_key', 'uuid', (column) => column.notNull().unique())
    .addColumn('created_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(db.fn('now')),
    )
    .addColumn('updated_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(db.fn('now')),
    )
    .addCheckConstraint(
      'stock_requests_status_valid',
      sql`status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')`,
    )
    .execute();

  await db.schema
    .createIndex('stock_requests_branch_status_created_idx')
    .on('stock_requests')
    .columns(['branch_id', 'status', 'created_at'])
    .execute();

  await db.schema
    .createIndex('stock_requests_requester_created_idx')
    .on('stock_requests')
    .columns(['requested_by_user_id', 'created_at'])
    .execute();

  await db.schema
    .createTable('stock_request_items')
    .addColumn('id', 'uuid', (column) =>
      column.primaryKey().defaultTo(db.fn('gen_random_uuid')),
    )
    .addColumn('stock_request_id', 'uuid', (column) =>
      column.notNull().references('stock_requests.id').onDelete('restrict'),
    )
    .addColumn('stock_item_id', 'uuid', (column) =>
      column.notNull().references('stock_items.id').onDelete('restrict'),
    )
    .addColumn('quantity_requested', 'numeric', (column) => column.notNull())
    .addColumn('created_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(db.fn('now')),
    )
    .addUniqueConstraint('stock_request_items_request_stock_item_unique', [
      'stock_request_id',
      'stock_item_id',
    ])
    .addCheckConstraint(
      'stock_request_items_quantity_positive',
      sql`quantity_requested > 0`,
    )
    .execute();

  await db.schema
    .createIndex('stock_request_items_stock_item_idx')
    .on('stock_request_items')
    .column('stock_item_id')
    .execute();

  await db.schema
    .createTable('stock_request_events')
    .addColumn('id', 'uuid', (column) =>
      column.primaryKey().defaultTo(db.fn('gen_random_uuid')),
    )
    .addColumn('stock_request_id', 'uuid', (column) =>
      column.notNull().references('stock_requests.id').onDelete('restrict'),
    )
    .addColumn('event_type', 'varchar(16)', (column) => column.notNull())
    .addColumn('actor_user_id', 'uuid', (column) =>
      column.notNull().references('auth.users.id').onDelete('restrict'),
    )
    .addColumn('created_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(db.fn('now')),
    )
    .addCheckConstraint(
      'stock_request_events_type_valid',
      sql`event_type IN ('SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELLED')`,
    )
    .execute();

  await db.schema
    .createIndex('stock_request_events_request_created_idx')
    .on('stock_request_events')
    .columns(['stock_request_id', 'created_at', 'id'])
    .execute();
}

// `any` is required here since migrations should be frozen in time. alternatively, keep a "snapshot" db interface.
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('stock_request_events').ifExists().execute();
  await db.schema.dropTable('stock_request_items').ifExists().execute();
  await db.schema.dropTable('stock_requests').ifExists().execute();
}
