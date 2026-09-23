// Disposable HTTPS integration fixture. Run only after both repositories have been built.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const https = require('node:https');
const http = require('node:http');
const { Pool } = require('pg');
const { parse } = require('dotenv');
const { Kysely, PostgresDialect } = require('kysely');
const { Migrator } = require('kysely/migration');

const apiDir = path.resolve(__dirname, '..');
const appDir = path.resolve(apiDir, '../coms-app');
const cache = path.join(apiDir, 'node_modules/.cache/coms-auth-browser');
fs.mkdirSync(cache, { recursive: true });
const name = `coms_auth_browser_${crypto.randomUUID().replaceAll('-', '')}`;
const source = parse(fs.readFileSync(path.join(apiDir, '.env'))).DATABASE_URL;
const admin = new Pool({ connectionString: source });
let api, next, proxy, db;
let stopping = false;
let nextFailure;

async function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  const cleanup = [
    async () => {
      if (proxy) {
        proxy.closeAllConnections();
        proxy.close();
      }
      if (next && next.exitCode === null) next.kill();
    },
    async () => {
      if (api) await api.close();
    },
    async () => {
      if (db) await db.destroy();
    },
    async () => {
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
      const response = await fetch('http://127.0.0.1:3100/', {
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
    WEB_ORIGIN: 'https://localhost:3443',
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
  const email = 'browser-test@example.com';
  const password = crypto.randomBytes(24).toString('hex');
  const { hashPassword } = require('../dist/modules/auth/password-hashing');
  await db
    .insertInto('auth.users')
    .values({
      email,
      full_name: 'Browser Test',
      contact_number: 'isolated-browser',
      hashed_password: await hashPassword(password),
    })
    .execute();
  const { NestFactory } = require('@nestjs/core');
  const { ValidationPipe } = require('@nestjs/common');
  const { AuthModule } = require('../dist/modules/auth/auth.module');
  api = await NestFactory.create(AuthModule, {
    logger: ['warn', 'error'],
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
  await api.listen(3101, '127.0.0.1');
  next = spawn(
    process.execPath,
    [
      'node_modules/next/dist/bin/next',
      'start',
      '--hostname',
      '127.0.0.1',
      '--port',
      '3100',
    ],
    {
      cwd: appDir,
      env: { ...process.env, COMS_API_BASE_URL: 'http://127.0.0.1:3101' },
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
  const key = path.join(cache, 'key.pem'),
    cert = path.join(cache, 'cert.pem');
  if (!fs.existsSync(cert)) {
    execFileSync(
      process.env.OPENSSL_PATH || 'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        key,
        '-out',
        cert,
        '-days',
        '2',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost',
      ],
      { windowsHide: true, stdio: 'ignore' },
    );
  }
  proxy = https.createServer(
    { key: fs.readFileSync(key), cert: fs.readFileSync(cert) },
    (req, res) => {
      const upstream = http.request(
        {
          host: '127.0.0.1',
          port: 3100,
          path: req.url,
          method: req.method,
          headers: { ...req.headers, 'x-forwarded-proto': 'https' },
        },
        (response) => {
          res.writeHead(response.statusCode, response.headers);
          response.pipe(res);
        },
      );
      upstream.on('error', () => {
        res.writeHead(503);
        res.end('Starting test server');
      });
      req.pipe(upstream);
    },
  );
  await new Promise((resolve, reject) => {
    proxy.once('error', reject);
    proxy.listen(3443, '127.0.0.1', resolve);
  });
  fs.rmSync(path.join(cache, 'outage'), { force: true });
  fs.rmSync(path.join(cache, 'stop'), { force: true });
  fs.writeFileSync(
    path.join(cache, 'fixture.json'),
    JSON.stringify({
      databaseUrl: url.toString(),
      email,
      password,
      origin: process.env.WEB_ORIGIN,
    }),
  );
  console.log(
    'Disposable COMS HTTPS fixture ready at https://localhost:3443 (credentials stay in ignored test cache).',
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
