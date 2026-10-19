// Verifies the exact local catalog on a disposable database, then generates types.
require('ts-node/register/transpile-only');
const { randomUUID } = require('node:crypto');
const { readFileSync, readdirSync } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { Pool } = require('pg');
const { Kysely, PostgresDialect, sql } = require('kysely');
const { Migrator } = require('kysely/migration');
const { parse } = require('dotenv');
async function main() {
  const source =
    process.env.DATABASE_URL ?? parse(readFileSync('.env')).DATABASE_URL;
  const url = new URL(source);
  if (!['localhost', '127.0.0.1'].includes(url.hostname))
    throw Error('Verified loopback target required');
  const local = new Pool({ connectionString: source });
  const rows = (
    await local.query(
      'SELECT id, product_name, description, price, price_revision, setup_revision, service_types, is_active, created_at, updated_at FROM products ORDER BY id',
    )
  ).rows;
  await local.end();
  url.pathname = '/postgres';
  const admin = new Pool({ connectionString: url.toString() });
  const name = 'coms_category_verify_' + randomUUID().replaceAll('-', '');
  let db;
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    url.pathname = '/' + name;
    db = new Kysely({
      dialect: new PostgresDialect({
        pool: new Pool({ connectionString: url.toString() }),
      }),
    });
    const dir = path.resolve('src/database/migrations');
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.ts'))
      .sort();
    const latest = files.at(-1).slice(0, -3);
    assert.match(latest, /product_categories$/);
    const provider = {
      getMigrations: async () =>
        Object.fromEntries(
          files.map((f) => [f.slice(0, -3), require(path.join(dir, f))]),
        ),
    };
    const migrator = new Migrator({ db, provider });
    const previous = await migrator.migrateTo(files.at(-2).slice(0, -3));
    if (previous.error) throw previous.error;
    if (rows.length) await db.insertInto('products').values(rows).execute();
    const unknown = await db
      .insertInto('products')
      .values({ product_name: 'UNMAPPED VERIFICATION', price: '1' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const failed = await migrator.migrateUp();
    assert.match(
      String(failed.error),
      /Unmapped products.*UNMAPPED VERIFICATION/,
    );
    assert.equal(
      (
        await sql`SELECT to_regclass('public.product_categories') AS name`.execute(
          db,
        )
      ).rows[0].name,
      null,
    );
    await db.deleteFrom('products').where('id', '=', unknown.id).execute();
    const upgraded = await migrator.migrateUp();
    if (upgraded.error) throw upgraded.error;
    const mapped = await db
      .selectFrom('products as p')
      .innerJoin('product_categories as c', 'c.id', 'p.category_id')
      .select([
        'p.id',
        'p.product_name',
        'p.is_active',
        'c.name',
        'c.is_active as category_active',
      ])
      .execute();
    const { categoryProductNames } = require(path.join(dir, files.at(-1)));
    assert.equal(mapped.length, rows.length);
    for (const row of mapped) {
      assert.ok(categoryProductNames[row.name].includes(row.product_name));
      assert.ok(!row.is_active || row.category_active);
    }
    const categories = await db
      .selectFrom('product_categories')
      .selectAll()
      .execute();
    assert.equal(categories.length, 8);
    await assert.rejects(
      db
        .insertInto('product_categories')
        .values({ name: ' rice MEALS ' })
        .execute(),
    );
    await assert.rejects(
      db
        .insertInto('product_categories')
        .values({ name: 'rice MEALS' })
        .execute(),
    );
    await assert.rejects(
      db
        .insertInto('products')
        .values({ product_name: 'No category', price: '1' })
        .execute(),
    );
    await assert.rejects(
      db
        .insertInto('products')
        .values({
          product_name: 'Unknown category',
          price: '1',
          category_id: randomUUID(),
        })
        .execute(),
    );
    const down = await migrator.migrateDown();
    if (down.error) throw down.error;
    assert.deepEqual(
      await db
        .selectFrom('products')
        .select(Object.keys(rows[0] ?? { id: 1 }))
        .orderBy('id')
        .execute(),
      rows,
    );
    const again = await migrator.migrateUp();
    if (again.error) throw again.error;
    const codegen = path.resolve('node_modules/kysely-codegen/dist/cli/bin.js');
    const generated = spawnSync(
      process.execPath,
      [codegen, '--out-file', './src/database/db.d.ts'],
      {
        stdio: 'inherit',
        env: { ...process.env, DATABASE_URL: url.toString() },
      },
    );
    if (generated.status !== 0) throw Error('Code generation failed');
    console.log(
      `PASS: ${rows.length} exact local product mappings; unknown-name atomic failure; constraints; up/down/up; generated types.`,
    );
  } finally {
    if (db) await db.destroy();
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
