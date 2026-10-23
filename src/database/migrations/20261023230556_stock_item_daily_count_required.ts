import { sql, type Kysely } from 'kysely';

// `any` is required here since migrations should be frozen in time. alternatively, keep a "snapshot" db interface.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('stock_items')
    .addColumn('daily_count_required', 'boolean', (column) =>
      column.notNull().defaultTo(true),
    )
    .execute();
}

// `any` is required here since migrations should be frozen in time. alternatively, keep a "snapshot" db interface.
export async function down(db: Kysely<any>): Promise<void> {
  await sql`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM stock_items WHERE NOT daily_count_required) THEN
      RAISE EXCEPTION 'Daily-count exclusions exist; restore them before rolling back.';
    END IF;
  END $$`.execute(db);
  await db.schema
    .alterTable('stock_items')
    .dropColumn('daily_count_required')
    .execute();
  // For more info, see: https://kysely.dev/docs/migrations
}
