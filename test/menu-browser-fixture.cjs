// Disposable loopback integration fixture. Run only after both repositories have been built.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { Pool } = require('pg');
const { parse } = require('dotenv');
const { Kysely, PostgresDialect } = require('kysely');
const { Migrator } = require('kysely/migration');

const apiDir = path.resolve(__dirname, '..');
const appDir = path.resolve(apiDir, '../coms-app');
const cache = path.join(apiDir, 'node_modules/.cache/coms-menu-browser');
fs.mkdirSync(cache, { recursive: true });
const name = `coms_menu_browser_${crypto.randomUUID().replaceAll('-', '')}`;
const source = parse(fs.readFileSync(path.join(apiDir, '.env'))).DATABASE_URL;
if (!['localhost', '127.0.0.1'].includes(new URL(source).hostname))
  throw Error('Browser fixture requires loopback');
const admin = new Pool({ connectionString: source });
let api, next, db;
let stopping = false;
let nextFailure;

async function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  const cleanup = [
    async () => {
      if (next && next.exitCode === null) next.kill();
    },
    async () => {
      if (api) await api.close();
    },
    async () => {
      if (db) await db.destroy();
    },
    async () => {
      if (!/^coms_menu_browser_[0-9a-f]+$/.test(name))
        throw Error('Unsafe browser cleanup');
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    },
    async () => {
      await admin.end();
    },
    async () => {
      fs.rmSync(path.join(cache, 'fixture.json'), { force: true });
    },
  ];
  for (const operation of cleanup) {
    try {
      await operation();
    } catch {
      exitCode = 1;
      console.error(
        'Disposable auth fixture cleanup failed. Check the test database and ports.',
      );
    }
  }
  process.exit(exitCode);
}

async function waitForNext() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (nextFailure) throw nextFailure;
    try {
      const response = await fetch('http://127.0.0.1:3140/', {
        signal: AbortSignal.timeout(1000),
        redirect: 'manual',
      });
      await response.arrayBuffer();
      if (response.status === 200 && !nextFailure) return;
    } catch {
      /* Keep waiting for this child to start listening. */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    'Next.js test server did not become ready within 30 seconds.',
  );
}

async function start() {
  await admin.query(`CREATE DATABASE "${name}"`);
  const url = new URL(source);
  url.pathname = `/${name}`;
  Object.assign(process.env, {
    NODE_ENV: 'production',
    DATABASE_URL: url.toString(),
    JWT_ACCESS_SECRET: crypto.randomBytes(32).toString('hex'),
    JWT_REFRESH_SECRET: crypto.randomBytes(32).toString('hex'),
    COMS_AUTH_GATEWAY_SECRET: crypto.randomBytes(32).toString('hex'),
    JWT_ACCESS_EXPIRES_IN: '15m',
    JWT_REFRESH_EXPIRES_IN: '30d',
    WEB_ORIGIN: 'http://localhost:3140',
  });
  db = new Kysely({
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString: url.toString() }),
    }),
  });
  const migrations = Object.fromEntries(
    fs
      .readdirSync(path.join(apiDir, 'dist/database/migrations'))
      .filter((file) => file.endsWith('.js'))
      .sort()
      .map((file) => [
        file.slice(0, -3),
        require(path.join(apiDir, 'dist/database/migrations', file)),
      ]),
  );
  const result = await new Migrator({
    db,
    provider: { getMigrations: async () => migrations },
  }).migrateToLatest();
  if (result.error) throw result.error;
  const password = 'MenuBrowserOnly!2026';
  const { hashPassword } = require('../dist/modules/auth/password-hashing');
  const passwordHash = await hashPassword(password);
  const users = {};
  for (const [label, code] of [
    ['manager', 'BRANCH_MANAGER'],
    ['central', 'SUPER_ADMIN'],
    ['cashier', 'CASHIER'],
  ]) {
    const role = await db
      .selectFrom('auth.roles')
      .select('id')
      .where('code', '=', code)
      .executeTakeFirstOrThrow();
    users[label] = (
      await db
        .insertInto('auth.users')
        .values({
          email: label + '@menu-browser.invalid',
          full_name: 'Synthetic ' + label,
          contact_number: 'isolated-' + label,
          hashed_password: passwordHash,
          role_id: role.id,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
  }
  const branch = (
    await db
      .insertInto('branches')
      .values({
        code: 'MENU-BROWSER-A',
        branch_name: 'Demo dining branch',
        has_dine_in: true,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;
  const takeawayBranch = (
    await db
      .insertInto('branches')
      .values({
        code: 'MENU-BROWSER-B',
        branch_name: 'Demo takeout branch',
        has_dine_in: false,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;
  for (const user_id of Object.values(users))
    await db
      .insertInto('auth.branch_users')
      .values({ branch_id: branch, user_id })
      .execute();
  for (const user_id of [users.central, users.cashier])
    await db
      .insertInto('auth.branch_users')
      .values({ branch_id: takeawayBranch, user_id })
      .execute();
  const stock = (
    await db
      .insertInto('stock_items')
      .values({
        stock_item_name: 'Demo chicken',
        category: 'Meat',
        unit: 'kg',
        usage_types: ['INGREDIENT'],
      })
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;
  const box = (
    await db
      .insertInto('stock_items')
      .values({
        stock_item_name: 'Demo takeout box',
        usage_types: ['PACKAGING'],
        category: 'Other',
        unit: 'pcs',
      })
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;
  const products = {};
  const drink = (
    await db
      .insertInto('stock_items')
      .values({
        stock_item_name: 'Demo bottled drink',
        category: 'Drinks',
        unit: 'bottle',
        usage_types: ['READY_TO_SELL'],
      })
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;
  await db
    .insertInto('stock_items')
    .values({
      stock_item_name: 'Demo plastic gloves',
      category: 'Other',
      unit: 'pair',
      usage_types: ['OPERATING_SUPPLY'],
    })
    .execute();
  for (const [label, product_name] of [
    ['meal', 'Demo chicken meal'],
    ['special', 'Demo grilled meal'],
    ['unpriced', 'Demo unpriced meal'],
  ]) {
    const product = (
      await db
        .insertInto('products')
        .values({
          product_name,
          category_id: db.selectFrom('product_categories').select('id').where('name', '=', 'Rice meals'),
          description: 'Synthetic browser fixture',
          price: label === 'meal' ? '120.001' : '135.005',
          recipe_revision: 1,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    products[label] = product;
    await db
      .insertInto('product_ingredients')
      .values([
        {
          product_id: product,
          stock_item_id: stock,
          quantity_required: '0.1',
          usage_scope: 'ALL',
        },
        {
          product_id: product,
          stock_item_id: box,
          component_type: 'PACKAGING',
          quantity_required: '1',
          usage_scope: 'TAKEAWAY',
        },
      ])
      .execute();
    if (label !== 'unpriced')
      for (const branch_id of [branch, takeawayBranch])
        await db
          .insertInto('branch_product_prices')
          .values({
            branch_id,
            product_id: product,
            price: label === 'meal' ? '120.001' : '135.005',
            updated_by_user_id: users.central,
          })
          .execute();
  }
  for (const branch_id of [branch, takeawayBranch]) {
    await db
      .insertInto('branch_products')
      .values({
        branch_id,
        product_id: products.meal,
        price: '120.001',
        service_types: ['DINE_IN', 'TAKEAWAY'],
      })
      .execute();
    await db
      .insertInto('branch_inventory')
      .values([
        { branch_id, stock_item_id: stock, quantity_on_hand: '100' },
        { branch_id, stock_item_id: box, quantity_on_hand: '100' },
        { branch_id, stock_item_id: drink, quantity_on_hand: '100' },
      ])
      .execute();
  }
  const email = 'manager@menu-browser.invalid';
  const { NestFactory } = require('@nestjs/core');
  const { ValidationPipe } = require('@nestjs/common');
  const { AppModule, ObserveInstrument } = require('../dist/app.module');
  api = await NestFactory.create(AppModule, {
    logger: ['warn', 'error'],
    instrument: ObserveInstrument,
    abortOnError: false,
  });
  api.use(require('cookie-parser')());
  api.use((_req, res, nextMiddleware) => {
    if (fs.existsSync(path.join(cache, 'outage')))
      return res
        .status(503)
        .json({ message: 'Authentication service unavailable' });
    nextMiddleware();
  });
  api.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  await api.listen(3141, '127.0.0.1');
  next = spawn(
    process.execPath,
    [
      'node_modules/next/dist/bin/next',
      'start',
      '--hostname',
      '127.0.0.1',
      '--port',
      '3140',
    ],
    {
      cwd: appDir,
      env: { ...process.env, COMS_API_BASE_URL: 'http://127.0.0.1:3141' },
      windowsHide: true,
      stdio: 'inherit',
    },
  );
  next.on('error', () => {
    nextFailure = new Error('Next.js test server failed to start.');
    void stop(1);
  });
  next.on('exit', () => {
    if (!stopping) {
      nextFailure = new Error('Next.js test server exited unexpectedly.');
      console.error(nextFailure.message);
      void stop(1);
    }
  });
  await waitForNext();
  fs.rmSync(path.join(cache, 'outage'), { force: true });
  fs.rmSync(path.join(cache, 'stop'), { force: true });
  fs.writeFileSync(
    path.join(cache, 'fixture.json'),
    JSON.stringify({
      databaseUrl: url.toString(),
      users,
      branch,
      takeawayBranch,
      products,
      stock,
      box,
      email,
      password,
      origin: process.env.WEB_ORIGIN,
    }),
  );
  console.log(
    'Disposable COMS fixture ready at http://localhost:3140 (credentials stay in ignored test cache).',
  );
  setInterval(() => {
    if (fs.existsSync(path.join(cache, 'stop'))) void stop();
  }, 500).unref();
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
process.stdin.on('data', (data) => {
  if (data.toString().trim() === 'stop') void stop();
});
start().catch(async (error) => {
  console.error(error.message);
  await stop(1);
});
