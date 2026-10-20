import { sql, type Kysely } from 'kysely';

// Applied migrations stay immutable. These are the only legacy wall-clock columns.
const columnsByTable = {
  'auth.users': ['created_at', 'updated_at'],
  'auth.sessions': ['created_at', 'expires_at', 'revoked_at'],
  'auth.token_families': ['created_at', 'expires_at', 'revoked_at'],
  'auth.refresh_tokens': [
    'created_at',
    'expires_at',
    'consumed_at',
    'revoked_at',
  ],
};

async function convert(db: Kysely<any>, direction: 'up' | 'down') {
  // Verified COMS development writers used UTC+8. Other installations must audit
  // their historical writers and explicitly override this before migrating.
  const zone = process.env.COMS_LEGACY_TIMESTAMP_TIME_ZONE ?? 'Asia/Manila';
  const valid = await sql<{ valid: boolean }>`
    SELECT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = ${zone}) AS valid
  `.execute(db);
  if (!valid.rows[0]?.valid)
    throw new Error('Invalid COMS legacy timestamp time zone');

  const type =
    direction === 'up' ? sql`timestamptz` : sql`timestamp without time zone`;
  // One ALTER per table avoids repeating its rewrite. Kysely runs the migration
  // transactionally; an error rolls back every table and the migration record.
  await sql`SET LOCAL lock_timeout = '10s'`.execute(db);
  for (const [table, columns] of Object.entries(columnsByTable)) {
    const changes = columns.map(
      (column) => sql`
      ALTER COLUMN ${sql.ref(column)} TYPE ${type}
      USING ${sql.ref(column)} AT TIME ZONE ${sql.lit(zone)}
    `,
    );
    await sql`ALTER TABLE ${sql.table(table)} ${sql.join(changes)}`.execute(db);
  }
}

export async function up(db: Kysely<any>): Promise<void> {
  await convert(db, 'up');
}

// Use the same legacy zone as up. Prefer retaining timestamptz on code rollback.
export async function down(db: Kysely<any>): Promise<void> {
  await convert(db, 'down');
}
