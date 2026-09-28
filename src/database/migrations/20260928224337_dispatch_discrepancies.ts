import { sql, type Kysely } from 'kysely';

// `any` keeps this migration frozen against the schema version it changes.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('dispatch_discrepancies')
    .addColumn('id', 'uuid', (column) =>
      column.primaryKey().defaultTo(db.fn('gen_random_uuid')),
    )
    .addColumn('dispatch_id', 'uuid', (column) =>
      column.notNull().references('dispatches.id').onDelete('restrict'),
    )
    .addColumn('status', 'varchar(24)', (column) =>
      column.notNull().defaultTo('OPEN'),
    )
    .addColumn('reported_by_user_id', 'uuid', (column) =>
      column.notNull().references('auth.users.id').onDelete('restrict'),
    )
    .addColumn('recount_requested_by_user_id', 'uuid', (column) =>
      column.references('auth.users.id').onDelete('restrict'),
    )
    .addColumn('idempotency_key', 'uuid', (column) => column.notNull().unique())
    .addColumn('reported_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(db.fn('now')),
    )
    .addColumn('recount_requested_at', 'timestamptz')
    .addColumn('resolved_at', 'timestamptz')
    .addColumn('updated_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(db.fn('now')),
    )
    .addCheckConstraint(
      'dispatch_discrepancies_status_valid',
      sql`status IN ('OPEN', 'RECOUNT_REQUESTED', 'RESOLVED')`,
    )
    .addCheckConstraint(
      'dispatch_discrepancies_status_timestamps_valid',
      sql`(status = 'OPEN' AND recount_requested_by_user_id IS NULL AND recount_requested_at IS NULL AND resolved_at IS NULL)
        OR (status = 'RECOUNT_REQUESTED' AND recount_requested_by_user_id IS NOT NULL AND recount_requested_at IS NOT NULL AND resolved_at IS NULL)
        OR (status = 'RESOLVED' AND resolved_at IS NOT NULL)`,
    )
    .execute();

  await sql`
    CREATE UNIQUE INDEX dispatch_discrepancies_one_active_per_dispatch
    ON dispatch_discrepancies (dispatch_id)
    WHERE status <> 'RESOLVED'
  `.execute(db);

  await db.schema
    .createIndex('dispatch_discrepancies_status_reported_idx')
    .on('dispatch_discrepancies')
    .columns(['status', 'reported_at', 'id'])
    .execute();

  await db.schema
    .createTable('dispatch_discrepancy_events')
    .addColumn('id', 'uuid', (column) =>
      column.primaryKey().defaultTo(db.fn('gen_random_uuid')),
    )
    .addColumn('discrepancy_id', 'uuid', (column) =>
      column
        .notNull()
        .references('dispatch_discrepancies.id')
        .onDelete('restrict'),
    )
    .addColumn('event_type', 'varchar(32)', (column) => column.notNull())
    .addColumn('actor_user_id', 'uuid', (column) =>
      column.notNull().references('auth.users.id').onDelete('restrict'),
    )
    .addColumn('note', 'text', (column) => column.notNull())
    .addColumn('idempotency_key', 'uuid', (column) => column.notNull().unique())
    .addColumn('created_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(db.fn('now')),
    )
    .addCheckConstraint(
      'dispatch_discrepancy_events_type_valid',
      sql`event_type IN ('REPORTED', 'RECOUNT_REQUESTED', 'RESOLVED_RECEIVED', 'RESOLVED_SHORTAGE')`,
    )
    .addCheckConstraint(
      'dispatch_discrepancy_events_note_nonblank',
      sql`char_length(btrim(note)) > 0`,
    )
    .execute();

  await db.schema
    .createIndex('dispatch_discrepancy_events_discrepancy_created_idx')
    .on('dispatch_discrepancy_events')
    .columns(['discrepancy_id', 'created_at', 'id'])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  const records = await sql<{ count: number }>`
    SELECT count(*)::int AS count FROM dispatch_discrepancies
  `.execute(db);
  if ((records.rows[0]?.count ?? 0) > 0) {
    throw new Error(
      'Cannot roll back dispatch discrepancies while discrepancy records or their audit history exist.',
    );
  }

  await db.schema.dropTable('dispatch_discrepancy_events').execute();
  await db.schema
    .dropIndex('dispatch_discrepancies_status_reported_idx')
    .execute();
  await sql`DROP INDEX dispatch_discrepancies_one_active_per_dispatch`.execute(
    db,
  );
  await db.schema.dropTable('dispatch_discrepancies').execute();
}
