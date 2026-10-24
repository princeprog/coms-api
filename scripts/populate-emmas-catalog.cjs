const { createHash } = require('node:crypto');
const fs = require('node:fs');
const { parse } = require('dotenv');
const { Pool } = require('pg');
const catalog = require('./emmas-chicken-catalog.cjs');

const seedName = 'emmas-three-branch-catalog-v1';
const tablesChanged = new Set([
  'branches',
  'stock_items',
  'products',
  'product_ingredients',
  'branch_products',
  'audit_events',
]);
const services = ['DINE_IN', 'TAKEAWAY'];
function id(key) {
  const b = createHash('sha256')
    .update(`${seedName}:${key}`)
    .digest()
    .subarray(0, 16);
  b[6] = (b[6] & 15) | 80;
  b[8] = (b[8] & 63) | 128;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
const quote = (s) => '"' + s.replaceAll('"', '""') + '"';
function validateCatalog() {
  for (const rows of [catalog.branches, catalog.stock, catalog.products]) {
    const keys = rows.map((r) => r.key ?? r.code);
    if (new Set(keys).size !== keys.length)
      throw Error('Duplicate catalog key');
  }
  if (catalog.branches.length !== 3)
    throw Error('Exactly three branches required');
  for (const product of catalog.products) {
    if (!/^\d+\.\d{2}$/.test(product.price) || !product.recipe.length)
      throw Error('Invalid price or missing recipe');
    const seen = new Set();
    for (const line of product.recipe) {
      const stock = catalog.stock.find((s) => s.key === line.key);
      if (!stock || stock.usage_types.includes('OPERATING_SUPPLY'))
        throw Error('Invalid recipe stock');
      if (
        !/^\d+(\.\d{1,4})?$/.test(line.quantity) ||
        Number(line.quantity) <= 0
      )
        throw Error('Invalid recipe quantity');
      if (!['ALL', ...services].includes(line.scope) || seen.has(line.key))
        throw Error('Duplicate stock or invalid recipe scope');
      if (stock.usage_types.includes('PACKAGING') && line.scope !== 'TAKEAWAY')
        throw Error('Packaging must apply only to takeout');
      seen.add(line.key);
    }
  }
}
async function insert(client, table, rows) {
  const columns = Object.keys(rows[0]);
  const values = [];
  const tuples = rows.map(
    (row) =>
      '(' +
      columns
        .map((column) => {
          values.push(row[column]);
          return '$' + values.length;
        })
        .join(',') +
      ')',
  );
  await client.query(
    `insert into ${quote(table)} (${columns.map(quote).join(',')}) values ${tuples.join(',')}`,
    values,
  );
}
async function unchangedSnapshot(client) {
  const tables = (
    await client.query(
      "select schemaname,tablename from pg_tables where schemaname in ('public','coms_auth') order by schemaname,tablename",
    )
  ).rows.filter(
    (t) => t.schemaname !== 'public' || !tablesChanged.has(t.tablename),
  );
  const sql = tables
    .map(({ schemaname, tablename }) => {
      const name = quote(schemaname) + '.' + quote(tablename);
      return `select '${schemaname}.${tablename}' as name, count(*)::text as count, md5(coalesce(string_agg(to_jsonb(t)::text, '' order by to_jsonb(t)::text),'')) as digest from ${name} t`;
    })
    .join(' union all ');
  return JSON.stringify((await client.query(sql)).rows);
}
async function verify(client) {
  const result = (
    await client.query(`select
    (select count(*)::int from branches) branches,
    (select count(*)::int from stock_items) stock_items,
    (select count(*)::int from products) products,
    (select count(*)::int from branch_products) menu_entries,
    (select count(*)::int from product_ingredients) recipe_lines,
    (select count(*)::int from stock_items where daily_count_required) daily_count_items,
    (select count(*)::int from branch_products bp join products p on p.id=bp.product_id join branches b on b.id=bp.branch_id
      where bp.price<>p.price or not bp.is_available or bp.service_types<>p.service_types or not b.has_dine_in or not b.has_takeaway) invalid_menus,
    (select count(*)::int from products p where not exists(select 1 from product_ingredients pi where pi.product_id=p.id)) missing_recipes,
    (select count(*)::int from product_ingredients pi join stock_items s on s.id=pi.stock_item_id
      where s.usage_types @> array['OPERATING_SUPPLY']::text[] or pi.quantity_required<=0 or not s.is_active) invalid_recipes
  `)
  ).rows[0];
  if (
    result.branches !== 3 ||
    result.stock_items !== catalog.stock.length ||
    result.products !== catalog.products.length ||
    result.menu_entries !== 3 * catalog.products.length ||
    result.recipe_lines !==
      catalog.products.reduce((n, p) => n + p.recipe.length, 0) ||
    result.invalid_menus ||
    result.missing_recipes ||
    result.invalid_recipes
  )
    throw Error('Catalog verification failed');
  return result;
}
async function populate(client) {
  validateCatalog();
  await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
    seedName,
  ]);
  await client.query(
    'lock table branches, stock_items, products, product_ingredients, branch_products in share row exclusive mode',
  );
  const existing = (
    await client.query(
      'select id from branches union all select id from stock_items union all select id from products',
    )
  ).rows;
  if (existing.length) {
    const expected = new Set([
      ...catalog.branches.map((r) => id('branch:' + r.code)),
      ...catalog.stock.map((r) => id('stock:' + r.key)),
      ...catalog.products.map((r) => id('product:' + r.key)),
    ]);
    if (
      existing.length !== expected.size ||
      existing.some((r) => !expected.has(r.id))
    )
      throw Error(
        'Catalog is not empty or contains unrelated data; refusing to overwrite it',
      );
    return { already_populated: true, ...(await verify(client)) };
  }
  const before = await unchangedSnapshot(client);
  const admins = (
    await client.query(
      "select u.id from coms_auth.users u join coms_auth.roles r on r.id=u.role_id where u.is_active and r.is_active and r.is_system and r.code='SUPER_ADMIN'",
    )
  ).rows;
  if (admins.length !== 1)
    throw Error(
      'Expected exactly one active Super Admin for audit attribution',
    );
  await client.query("select set_config('coms.actor_id',$1,true)", [
    admins[0].id,
  ]);
  const categories = (
    await client.query('select id,name from product_categories where is_active')
  ).rows;
  for (const p of catalog.products)
    if (!categories.some((c) => c.name === p.category))
      throw Error('Required product category missing: ' + p.category);
  await insert(
    client,
    'branches',
    catalog.branches.map((r) => ({
      ...r,
      id: id('branch:' + r.code),
      has_dine_in: true,
      has_takeaway: true,
      status: 'active',
    })),
  );
  await insert(
    client,
    'stock_items',
    catalog.stock.map(({ key, ...r }) => ({ id: id('stock:' + key), ...r })),
  );
  await insert(
    client,
    'products',
    catalog.products.map((p) => ({
      id: id('product:' + p.key),
      product_name: p.product_name,
      category_id: categories.find((c) => c.name === p.category).id,
      price: p.price,
      description: p.description,
      service_types: services,
      recipe_revision: 1,
    })),
  );
  await insert(
    client,
    'product_ingredients',
    catalog.products.flatMap((p) =>
      p.recipe.map((l) => ({
        product_id: id('product:' + p.key),
        stock_item_id: id('stock:' + l.key),
        quantity_required: l.quantity,
        usage_scope: l.scope,
        component_type: 'INGREDIENT',
      })),
    ),
  );
  await insert(
    client,
    'branch_products',
    catalog.branches.flatMap((b) =>
      catalog.products.map((p) => ({
        branch_id: id('branch:' + b.code),
        product_id: id('product:' + p.key),
        price: p.price,
        service_types: services,
        is_available: true,
      })),
    ),
  );
  const result = await verify(client);
  if (before !== (await unchangedSnapshot(client)))
    throw Error('An unrelated table changed');
  await client.query(
    `insert into audit_events (actor_user_id,actor_name,action,entity_type,entity_id,entity_label,metadata)
    select id,full_name,'catalog.initialized','catalog',$1,'Emma''s Chicken House starter catalog',$2::jsonb from coms_auth.users where id=$3`,
    [
      seedName,
      JSON.stringify({
        ...result,
        starter_prices: true,
        opening_stock_added: false,
      }),
      admins[0].id,
    ],
  );
  return { already_populated: false, ...result };
}
async function main() {
  const args = process.argv.slice(2);
  const allowed =
    /^(--apply|--check|--env-file=.+|--expected-host=.+|--expected-database=.+)$/;
  if (
    args.some((a) => !allowed.test(a)) ||
    args.filter((a) => /^--(apply|check)$/.test(a)).length > 1
  )
    throw Error('Invalid arguments');
  const value = (name) =>
    args.find((a) => a.startsWith(name + '='))?.slice(name.length + 1);
  const envFile = value('--env-file');
  const connectionString = envFile
    ? parse(fs.readFileSync(envFile)).DATABASE_URL
    : process.env.DATABASE_URL;
  if (!connectionString)
    throw Error('Supply DATABASE_URL or an explicit --env-file');
  const url = new URL(connectionString);
  if (
    url.hostname !== value('--expected-host') ||
    decodeURIComponent(url.pathname.slice(1)) !== value('--expected-database')
  )
    throw Error('Explicit expected host/database must match the connection');
  const pool = new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 10000,
  });
  const client = await pool.connect();
  try {
    await client.query('begin isolation level serializable');
    await client.query("set local lock_timeout='10s'");
    await client.query("set local statement_timeout='60s'");
    const result = await populate(client);
    // Re-running is a no-op, including its audit events.
    const audit = (
      await client.query('select count(*)::int n from audit_events')
    ).rows[0].n;
    if (
      !(await populate(client)).already_populated ||
      audit !==
        (await client.query('select count(*)::int n from audit_events')).rows[0]
          .n
    )
      throw Error('Repeat-run verification failed');
    await client.query(args.includes('--apply') ? 'commit' : 'rollback');
    console.log(
      JSON.stringify({
        mode: args.includes('--apply') ? 'committed' : 'dry-run-rolled-back',
        host: url.hostname,
        database: decodeURIComponent(url.pathname.slice(1)),
        ...result,
      }),
    );
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}
if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = { populate, verify, validateCatalog, id };
