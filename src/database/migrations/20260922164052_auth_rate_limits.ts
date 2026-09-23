import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .withSchema('auth')
    .createTable('rate_limit_buckets')
    .addColumn('scope', 'varchar(20)', (c) => c.notNull())
    .addColumn('key_hash', 'varchar(64)', (c) => c.notNull())
    .addColumn('count', 'integer', (c) => c.notNull())
    .addColumn('reset_at', 'timestamptz', (c) => c.notNull())
    .addPrimaryKeyConstraint('rate_limit_buckets_pk', ['scope', 'key_hash'])
    .addCheckConstraint('rate_limit_count_positive', sql`count > 0`)
    .execute();
  await db.schema
    .withSchema('auth')
    .createIndex('rate_limit_buckets_expiry')
    .on('rate_limit_buckets')
    .column('reset_at')
    .execute();
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.withSchema('auth').dropTable('rate_limit_buckets').execute();
}
