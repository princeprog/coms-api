// Runs integration checks only against a newly created, uniquely named database.
require('ts-node/register/transpile-only');
const { randomUUID } = require('node:crypto');
const { readFileSync, readdirSync } = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parse } = require('dotenv');
const { Pool } = require('pg');
const { Kysely, PostgresDialect } = require('kysely');
const { Migrator } = require('kysely/migration');

async function main() {
  const source =
    process.env.COMS_TEST_ADMIN_URL ?? parse(readFileSync('.env')).DATABASE_URL;
  const url = new URL(source);
  url.pathname = '/postgres';
  const admin = new Pool({ connectionString: url.toString() });
  const name = `coms_dispatch_test_${randomUUID().replaceAll('-', '')}`;
  let db;
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    url.pathname = `/${name}`;
    db = new Kysely({
      dialect: new PostgresDialect({
        pool: new Pool({ connectionString: url.toString() }),
      }),
    });
    const directory = path.resolve('src/database/migrations');
    const migrator = new Migrator({
      db,
      provider: {
        getMigrations: async () =>
          Object.fromEntries(
            readdirSync(directory)
              .filter((file) => file.endsWith('.ts'))
              .map((file) => [
                file.slice(0, -3),
                require(path.join(directory, file)),
              ]),
          ),
      },
    });
    const result = await migrator.migrateToLatest();
    if (result.error) throw result.error;
    await db
      .insertInto('auth.users')
      .values({
        email: 'dispatch-test@example.test',
        full_name: 'Disposable test operator',
        contact_number: 'disposable',
        hashed_password: 'test-only',
      })
      .execute();
    console.log(
      `Disposable integration database: ${name}; migrations: ${result.results.length}`,
    );
    await db.destroy();
    db = undefined;
    const cli = path.join(
      path.dirname(require.resolve('vitest/package.json')),
      'vitest.mjs',
    );
    const args = process.argv.slice(2);
    const run = spawnSync(
      process.execPath,
      [
        cli,
        'run',
        '--config',
        'vitest.config.e2e.ts',
        ...(args.length ? args : ['test/dispatches.e2e-spec.ts']),
      ],
      {
        stdio: 'inherit',
        env: {
          ...process.env,
          DATABASE_URL: url.toString(),
          COMS_TEST_DATABASE_NAME: name,
        },
      },
    );
    process.exitCode = run.status ?? 1;
  } finally {
    if (db) await db.destroy();
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
    console.log(`Disposed integration database: ${name}`);
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
