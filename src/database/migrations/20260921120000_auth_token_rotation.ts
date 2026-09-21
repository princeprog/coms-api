import type { Kysely } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('auth.token_families')
    .addColumn('id', 'uuid', (column) =>
      column.primaryKey().defaultTo(db.fn('gen_random_uuid')),
    )
    .addColumn('user_id', 'uuid', (column) =>
      column.notNull().references('auth.users.id').onDelete('cascade'),
    )
    .addColumn('expires_at', 'timestamp', (column) => column.notNull())
    .addColumn('created_at', 'timestamp', (column) =>
      column.notNull().defaultTo(db.fn('now')),
    )
    .addColumn('revoked_at', 'timestamp')
    .execute();

  await db.schema
    .createTable('auth.refresh_tokens')
    .addColumn('id', 'uuid', (column) =>
      column.primaryKey().defaultTo(db.fn('gen_random_uuid')),
    )
    .addColumn('family_id', 'uuid', (column) =>
      column.notNull().references('auth.token_families.id').onDelete('cascade'),
    )
    .addColumn('token_hash', 'varchar(64)', (column) =>
      column.notNull().unique(),
    )
    .addColumn('expires_at', 'timestamp', (column) => column.notNull())
    .addColumn('created_at', 'timestamp', (column) =>
      column.notNull().defaultTo(db.fn('now')),
    )
    .addColumn('consumed_at', 'timestamp')
    .addColumn('revoked_at', 'timestamp')
    .addColumn('replaced_by_id', 'uuid')
    .execute();

  await db.schema
    .createIndex('auth_token_families_user_id_index')
    .on('auth.token_families')
    .column('user_id')
    .execute();

  await db.schema
    .createIndex('auth_token_families_expires_at_index')
    .on('auth.token_families')
    .column('expires_at')
    .execute();

  await db.schema
    .createIndex('auth_refresh_tokens_family_id_index')
    .on('auth.refresh_tokens')
    .column('family_id')
    .execute();

  await db.schema
    .createIndex('auth_refresh_tokens_expires_at_index')
    .on('auth.refresh_tokens')
    .column('expires_at')
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('auth.refresh_tokens').ifExists().execute();
  await db.schema.dropTable('auth.token_families').ifExists().execute();
}
