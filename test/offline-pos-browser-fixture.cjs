// Real API + production Next.js + HTTPS. Requires both builds; never builds them.
// Run: node test/offline-pos-browser-fixture.cjs
// Private contract: node_modules/.cache/coms-offline-browser/fixture.json
// Stop: write "stop" to stdin, send SIGINT/SIGTERM, or create cache/stop.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const https = require('node:https');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');
const { Pool } = require('pg');
const { parse } = require('dotenv');
const { Kysely, PostgresDialect } = require('kysely');
const { Migrator } = require('kysely/migration');

const apiDir = path.resolve(__dirname, '..');
const appDir = path.resolve(apiDir, '../coms-app');
const cache = path.join(apiDir, 'node_modules/.cache/coms-offline-browser');
const metadataFile = path.join(cache, 'fixture.json');
const lockFile = path.join(cache, 'fixture.lock');
const ports = { app: 3105, api: 3106, https: 3445 };
const origin = `https://localhost:${ports.https}`;
const name = `coms_offline_browser_${crypto.randomUUID().replaceAll('-', '')}`;
let api, next, proxy, db, admin, poller, logFd, startup;
let ownsLock = false,
  createdDatabase = false,
  stopping = false;
let stage = 'preflight',
  nextFailure;

function assertDatabaseName() {
  if (!/^coms_offline_browser_[a-f0-9]{32}$/.test(name))
    throw new Error('Invalid disposable database name');
}

function privateWrite(file, value) {
  fs.writeFileSync(file, value, { mode: 0o600 });
}

function requireRunning() {
  if (stopping) throw new Error('Fixture startup cancelled');
}

async function checkFreePorts() {
  // Bind all three simultaneously so a collision fails before creating a DB.
  const reservations = [];
  try {
    for (const port of Object.values(ports)) {
      const server = net.createServer();
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
      });
      reservations.push(server);
    }
  } finally {
    await Promise.all(
      reservations.map(
        (server) => new Promise((resolve) => server.close(resolve)),
      ),
    );
  }
}

function builtMigrations() {
  const sourceDir = path.join(apiDir, 'src/database/migrations');
  const distDir = path.join(apiDir, 'dist/database/migrations');
  const names = fs
    .readdirSync(sourceDir)
    .filter((file) => file.endsWith('.ts'))
    .map((file) => file.slice(0, -3))
    .sort();
  const built = fs
    .readdirSync(distDir)
    .filter((file) => file.endsWith('.js'))
    .map((file) => file.slice(0, -3))
    .sort();
  if (names.length < 50 || JSON.stringify(names) !== JSON.stringify(built))
    throw new Error(
      'Build API first: compiled migration set must match source',
    );
  if (
    !fs.existsSync(
      path.join(apiDir, 'dist/modules/pos-offline/pos-offline.module.js'),
    ) ||
    !fs.existsSync(path.join(appDir, '.next/BUILD_ID'))
  )
    throw new Error('Build API and frontend before running this fixture');
  return { names, distDir };
}

function certificate() {
  const candidates = [
    cache,
    path.join(apiDir, 'node_modules/.cache/coms-auth-browser'),
  ];
  for (const directory of candidates) {
    try {
      const key = fs.readFileSync(path.join(directory, 'key.pem'));
      const cert = fs.readFileSync(path.join(directory, 'cert.pem'));
      const parsed = new crypto.X509Certificate(cert);
      if (
        parsed.checkHost('localhost') &&
        Date.parse(parsed.validFrom) <= Date.now() &&
        Date.parse(parsed.validTo) > Date.now() + 3_600_000 &&
        parsed.checkPrivateKey(crypto.createPrivateKey(key))
      )
        return { key, cert };
    } catch {
      /* Missing or expired test certificate: use the next candidate. */
    }
  }
  const keyFile = path.join(cache, 'key.pem');
  const certFile = path.join(cache, 'cert.pem');
  const gitOpenSsl = path.join(
    process.env.ProgramFiles || 'C:/Program Files',
    'Git/usr/bin/openssl.exe',
  );
  const openssl =
    process.env.OPENSSL_PATH ||
    (fs.existsSync(gitOpenSsl) ? gitOpenSsl : 'openssl');
  execFileSync(
    openssl,
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyFile,
      '-out',
      certFile,
      '-days',
      '2',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ],
    { windowsHide: true, stdio: 'ignore' },
  );
  fs.chmodSync(keyFile, 0o600);
  return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
}

async function stopNext() {
  if (!next?.pid || next.exitCode !== null || next.signalCode !== null) return;
  const exited = new Promise((resolve) => next.once('exit', resolve));
  next.kill('SIGTERM');
  let timeout;
  await Promise.race([
    exited,
    new Promise((resolve) => {
      timeout = setTimeout(resolve, 5000);
    }),
  ]);
  clearTimeout(timeout);
  if (next.exitCode === null && next.signalCode === null) {
    // Only the child started by this fixture, never a process-name-wide kill.
    if (process.platform === 'win32')
      execFileSync('taskkill', ['/PID', String(next.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    else next.kill('SIGKILL');
    await exited;
  }
}

async function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  clearInterval(poller);
  // Wait for in-flight database creation/listen before releasing resources.
  // Startup checks cancellation between phases and cannot outlive cleanup.
  if (startup) await startup.catch(() => {});
  const cleanup = [
    async () => {
      if (proxy) {
        proxy.closeAllConnections();
        await new Promise((resolve) => proxy.close(resolve));
      }
    },
    stopNext,
    async () => {
      if (api) await api.close();
    },
    async () => {
      if (db) await db.destroy();
    },
    async () => {
      if (createdDatabase) {
        assertDatabaseName();
        await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      }
    },
    async () => {
      if (admin) await admin.end();
    },
    async () => {
      if (logFd !== undefined) fs.closeSync(logFd);
    },
    async () => {
      if (ownsLock) {
        fs.rmSync(metadataFile, { force: true });
        fs.rmSync(path.join(cache, 'stop'), { force: true });
        fs.rmSync(path.join(cache, 'api-outage'), { force: true });
        fs.rmSync(lockFile, { force: true });
      }
    },
  ];
  for (const operation of cleanup) {
    try {
      await operation();
    } catch {
      exitCode = 1;
      process.stderr.write(
        'Offline fixture cleanup failed; inspect its disposable database and private cache.\n',
      );
    }
  }
  process.exit(exitCode);
}

async function seed() {
  const { hashPassword } = require('../dist/modules/auth/password-hashing');
  const credentials = {};
  const users = {};
  for (const [kind, roleCode, fullName] of [
    ['cashier', 'CASHIER', 'Offline cashier'],
    ['manager', 'BRANCH_MANAGER', 'Offline branch manager'],
    ['superAdmin', 'SUPER_ADMIN', 'Offline administrator'],
  ]) {
    const role = await db
      .selectFrom('coms_auth.roles')
      .select('id')
      .where('code', '=', roleCode)
      .executeTakeFirstOrThrow();
    const email = `${kind}-${crypto.randomUUID()}@example.invalid`;
    const password = crypto.randomBytes(24).toString('base64url');
    const user = await db
      .insertInto('coms_auth.users')
      .values({
        email,
        full_name: fullName,
        contact_number: `offline-${kind}`,
        hashed_password: await hashPassword(password),
        role_id: role.id,
        is_active: true,
        must_change_password: false,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    credentials[kind] = { email, password };
    users[kind] = user.id;
  }
  const branch = await db
    .insertInto('branches')
    .values({
      code: 'OFFLINE-QA',
      branch_name: 'Offline browser branch',
      has_dine_in: true,
      has_takeaway: true,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await db
    .insertInto('coms_auth.branch_users')
    .values(
      ['cashier', 'manager'].map((kind) => ({
        user_id: users[kind],
        branch_id: branch.id,
      })),
    )
    .execute();
  const category = await db
    .selectFrom('product_categories')
    .select('id')
    .where('name', '=', 'Rice meals')
    .executeTakeFirstOrThrow();
  const product = await db
    .insertInto('products')
    .values({
      product_name: 'Chicken rice meal',
      category_id: category.id,
      price: '129.5',
      price_revision: 1,
      service_types: ['DINE_IN', 'TAKEAWAY'],
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await db
    .insertInto('branch_products')
    .values({
      branch_id: branch.id,
      product_id: product.id,
      price: '129.5',
      service_types: ['DINE_IN', 'TAKEAWAY'],
    })
    .execute();
  const stock = await db
    .insertInto('stock_items')
    .values({
      stock_item_name: 'Rice',
      category: 'Ingredient',
      unit: 'kg',
      usage_types: ['INGREDIENT'],
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await db
    .insertInto('product_ingredients')
    .values({
      product_id: product.id,
      stock_item_id: stock.id,
      quantity_required: '0.125',
      usage_scope: 'ALL',
    })
    .execute();
  await db
    .insertInto('branch_inventory')
    .values({
      branch_id: branch.id,
      stock_item_id: stock.id,
      quantity_on_hand: '100',
    })
    .execute();
  await db
    .insertInto('stock_item_costs')
    .values({
      stock_item_id: stock.id,
      average_unit_cost: '56',
      cost_source: 'MANUAL',
      updated_by_user_id: users.superAdmin,
    })
    .execute();
  const cash = await db
    .selectFrom('payment_methods')
    .select('id')
    .where('kind', '=', 'CASH')
    .where('is_active', '=', true)
    .executeTakeFirstOrThrow();
  // Shifts, register devices, approvals and sessions are deliberately created by the browser workflow.
  return {
    origin,
    email: credentials.cashier.email,
    password: credentials.cashier.password,
    managerEmail: credentials.manager.email,
    managerPassword: credentials.manager.password,
    superAdminEmail: credentials.superAdmin.email,
    superAdminPassword: credentials.superAdmin.password,
    cashierId: users.cashier,
    managerId: users.manager,
    superAdminId: users.superAdmin,
    branchId: branch.id,
    productId: product.id,
    stockItemId: stock.id,
    cashPaymentMethodId: cash.id,
    price: '129.5',
    ports,
    pid: process.pid,
  };
}

async function waitForNext() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    requireRunning();
    if (nextFailure) throw nextFailure;
    try {
      const response = await fetch(`http://127.0.0.1:${ports.app}/`, {
        signal: AbortSignal.timeout(1500),
        redirect: 'manual',
      });
      await response.arrayBuffer();
      if (response.status === 200 && !nextFailure) return;
    } catch {
      /* Poll this fixture's child until its login route is ready. */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Production frontend did not become ready');
}

async function start() {
  const compiled = builtMigrations();
  await checkFreePorts();
  requireRunning();
  fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
  const lock = fs.openSync(lockFile, 'wx', 0o600);
  ownsLock = true;
  fs.writeFileSync(lock, String(process.pid));
  fs.closeSync(lock);
  for (const file of [
    'fixture.json',
    'stop',
    'api-outage',
    'startup-error.log',
  ])
    fs.rmSync(path.join(cache, file), { force: true });
  const tls = certificate();
  const source =
    process.env.COMS_TEST_ADMIN_URL ||
    parse(fs.readFileSync(path.join(apiDir, '.env'))).DATABASE_URL;
  const url = new URL(source);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    throw new Error('Disposable fixture requires loopback PostgreSQL');
  url.pathname = '/postgres';
  admin = new Pool({ connectionString: url.toString(), max: 2 });
  assertDatabaseName();
  stage = 'database creation';
  await admin.query(`CREATE DATABASE "${name}"`);
  createdDatabase = true;
  requireRunning();
  url.pathname = `/${name}`;
  Object.assign(process.env, {
    NODE_ENV: 'production',
    DATABASE_URL: url.toString(),
    PORT: String(ports.api),
    JWT_ACCESS_SECRET: crypto.randomBytes(32).toString('hex'),
    JWT_REFRESH_SECRET: crypto.randomBytes(32).toString('hex'),
    COMS_AUTH_GATEWAY_SECRET: crypto.randomBytes(32).toString('hex'),
    JWT_ACCESS_EXPIRES_IN: '15m',
    JWT_REFRESH_EXPIRES_IN: '30d',
    JWT_ISSUER: 'coms-api',
    JWT_AUDIENCE: 'coms-web',
    WEB_ORIGIN: origin,
    COMS_OFFLINE_POS_ENABLED: 'true',
    DOTENV_CONFIG_QUIET: 'true',
    NEXT_TELEMETRY_DISABLED: '1',
    NEST_OBSERVE_APP_KEY: '',
    NEST_OBSERVE_APP_SECRET: '',
    DB_POOL_MAX: '5',
  });
  db = new Kysely({
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString: url.toString(), max: 3 }),
    }),
  });
  stage = 'compiled migrations';
  const migrations = Object.fromEntries(
    compiled.names.map((name) => [
      name,
      require(path.join(compiled.distDir, `${name}.js`)),
    ]),
  );
  const migrated = await new Migrator({
    db,
    provider: { getMigrations: async () => migrations },
  }).migrateToLatest();
  if (migrated.error) throw migrated.error;
  requireRunning();
  stage = 'isolated seed';
  const metadata = await seed();
  requireRunning();
  stage = 'full API';
  const { NestFactory } = require('@nestjs/core');
  const { ValidationPipe } = require('@nestjs/common');
  const { AppModule } = require('../dist/app.module');
  api = await NestFactory.create(AppModule, {
    logger: false,
    abortOnError: false,
  });
  api.use(require('cookie-parser')());
  api.use((_req, res, nextMiddleware) =>
    fs.existsSync(path.join(cache, 'api-outage'))
      ? res.status(503).json({ message: 'Fixture API outage' })
      : nextMiddleware(),
  );
  api.enableCors({ origin, credentials: true });
  api.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  await api.listen(ports.api, '127.0.0.1');
  requireRunning();
  stage = 'production frontend';
  const nextEnv = {
    ...process.env,
    COMS_API_BASE_URL: `http://127.0.0.1:${ports.api}`,
  };
  for (const key of [
    'DATABASE_URL',
    'COMS_TEST_ADMIN_URL',
    'JWT_ACCESS_SECRET',
    'JWT_REFRESH_SECRET',
  ])
    delete nextEnv[key];
  logFd = fs.openSync(path.join(cache, 'next.log'), 'w', 0o600);
  next = spawn(
    process.execPath,
    [
      'node_modules/next/dist/bin/next',
      'start',
      '--hostname',
      '127.0.0.1',
      '--port',
      String(ports.app),
    ],
    {
      cwd: appDir,
      env: nextEnv,
      windowsHide: true,
      stdio: ['ignore', logFd, logFd],
    },
  );
  next.on('error', () => {
    nextFailure = new Error('Fixture frontend failed to start');
    if (!stopping) void stop(1);
  });
  next.on('exit', () => {
    if (!stopping) {
      nextFailure = new Error('Fixture frontend exited unexpectedly');
      void stop(1);
    }
  });
  await waitForNext();
  requireRunning();
  stage = 'HTTPS proxy';
  proxy = https.createServer(tls, (req, res) => {
    const upstream = http.request(
      {
        host: '127.0.0.1',
        port: ports.app,
        path: req.url,
        method: req.method,
        headers: {
          ...req.headers,
          host: `localhost:${ports.https}`,
          'x-forwarded-host': `localhost:${ports.https}`,
          'x-forwarded-proto': 'https',
          'x-forwarded-port': String(ports.https),
        },
      },
      (response) => {
        res.writeHead(response.statusCode, response.headers);
        response.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(503);
      res.end('Fixture unavailable');
    });
    req.on('aborted', () => upstream.destroy());
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });
  await new Promise((resolve, reject) => {
    proxy.once('error', reject);
    proxy.listen(ports.https, '127.0.0.1', resolve);
  });
  requireRunning();
  privateWrite(
    metadataFile,
    JSON.stringify(
      { ...metadata, databaseUrl: url.toString(), databaseName: name },
      null,
      2,
    ),
  );
  poller = setInterval(() => {
    if (fs.existsSync(path.join(cache, 'stop'))) void stop();
  }, 500);
  poller.unref();
  process.stdout.write(`READY ${ports.https}\n`);
}

process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
process.stdin.on('data', (data) => {
  if (data.toString().trim() === 'stop') void stop();
});
startup = start();
startup.catch(async (error) => {
  if (stopping) return;
  if (ownsLock) {
    try {
      privateWrite(
        path.join(cache, 'startup-error.log'),
        String(error?.stack || error),
      );
    } catch {
      /* Keep credentials out of stderr. */
    }
  }
  process.stderr.write(
    `Offline fixture failed during ${stage}; see private startup-error.log if created.\n`,
  );
  await stop(1);
});
