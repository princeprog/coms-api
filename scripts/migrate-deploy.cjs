// Applies pending Kysely migrations during the production deployment build, after
// `nest build` and before the new API serves traffic. Preview and local builds skip,
// so only the production database is migrated. A failure fails the deployment.
const { readdirSync } = require('node:fs');
const path = require('node:path');

function deployMigrationPlan(env) {
  if (env.COMS_MIGRATE_ON_BUILD === 'true')
    return env.DATABASE_URL
      ? { action: 'migrate' }
      : { action: 'fail', reason: 'DATABASE_URL is required to migrate.' };
  if (!env.VERCEL) return { action: 'skip', reason: 'Not a Vercel build.' };
  if (!env.VERCEL_ENV)
    return {
      action: 'fail',
      reason:
        'VERCEL_ENV is unavailable, so the build cannot tell whether to migrate. Enable system environment variables.',
    };
  if (env.VERCEL_ENV !== 'production')
    return {
      action: 'skip',
      reason: `${env.VERCEL_ENV} deployments do not migrate.`,
    };
  if (!env.DATABASE_URL)
    return {
      action: 'fail',
      reason: 'DATABASE_URL is missing from the Production environment.',
    };
  return { action: 'migrate' };
}

async function migrate(connectionString) {
  const { Kysely, PostgresDialect } = require('kysely');
  const { Migrator } = require('kysely/migration');
  const { Pool } = require('pg');
  const directory = path.resolve(__dirname, '../dist/database/migrations');
  const files = readdirSync(directory).filter((file) => file.endsWith('.js'));
  if (!files.length)
    throw new Error('No compiled migrations found. Run nest build first.');
  const migrations = Object.fromEntries(
    files
      .sort()
      .map((file) => [file.slice(0, -3), require(path.join(directory, file))]),
  );
  const db = new Kysely({
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString, max: 1 }),
    }),
  });
  try {
    // Postgres supports transactional DDL, so a failed batch rolls back as a whole.
    // The migration lock serializes concurrent production builds.
    const { error, results = [] } = await new Migrator({
      db,
      provider: { getMigrations: async () => migrations },
    }).migrateToLatest();
    for (const result of results)
      console.log(`[migrations] ${result.status}: ${result.migrationName}`);
    if (error) throw error;
    console.log(
      results.length
        ? `[migrations] Applied ${results.length} pending migration(s); ${files.length} known.`
        : `[migrations] Database is current (${files.length} migrations).`,
    );
  } finally {
    await db.destroy();
  }
}

if (require.main === module) {
  const plan = deployMigrationPlan(process.env);
  if (plan.action === 'skip')
    console.log(`[migrations] Skipped: ${plan.reason}`);
  else if (plan.action === 'fail') {
    console.error(`[migrations] ${plan.reason}`);
    process.exitCode = 1;
  } else
    migrate(process.env.DATABASE_URL).catch((error) => {
      console.error(`[migrations] Failed: ${error.message}`);
      process.exitCode = 1;
    });
}

module.exports = { deployMigrationPlan };
