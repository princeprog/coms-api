import '../src/config/load-env';
import {
  ValidationPipe,
  type ExecutionContext,
  type INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { sql, type Kysely } from 'kysely';
import { Migrator } from 'kysely/migration';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { AuthGatewayGuard } from '../src/common/guards/auth-gateway.guard';
import { AuthGuard } from '../src/common/guards/auth.guard';
import { getAuthConfig } from '../src/config/auth.config';
import { createDatabase } from '../src/database/create-database';
import { DATABASE } from '../src/database/database.module';
import type { DB } from '../src/database/db';

describe.skipIf(process.env.COMS_RUN_DB_TESTS !== '1')('CSV exports', () => {
  const name = 'coms_export_test_' + randomUUID().replaceAll('-', '');
  let admin: Pool;
  let db: Kysely<DB>;
  let app: INestApplication;
  let superAdmin: string, noCosts: string;
  let supplier: string, garlic: string, onion: string;
  const as = (actor: string) => ({
    get: (path: string) =>
      request(app.getHttpServer()).get(path).set('x-test-actor', actor),
    post: (path: string) =>
      request(app.getHttpServer())
        .post(path)
        .set('x-test-actor', actor)
        .set('Origin', getAuthConfig().webOrigin),
  });
  const exportEvents = () =>
    db
      .selectFrom('audit_events')
      .selectAll()
      .where('action', '=', 'export.downloaded')
      .orderBy('occurred_at')
      .execute();
  const lines = (csv: string) => csv.replace(/^\uFEFF/, '').split('\r\n');

  beforeAll(async () => {
    const url = new URL(
      process.env.COMS_TEST_ADMIN_URL ?? process.env.DATABASE_URL!,
    );
    if (!['localhost', '127.0.0.1'].includes(url.hostname))
      throw Error('Use a verified loopback target');
    admin = new Pool({ connectionString: url.toString() });
    await admin.query(`CREATE DATABASE "${name}"`);
    url.pathname = '/' + name;
    db = createDatabase(url.toString(), 4);
    const migrations: Record<string, unknown> = {};
    for (const file of readdirSync('src/database/migrations')
      .filter((f) => f.endsWith('.ts'))
      .sort())
      migrations[file.slice(0, -3)] = await import(
        '../src/database/migrations/' + file
      );
    const migrated = await new Migrator({
      db,
      provider: { getMigrations: async () => migrations as never },
    }).migrateToLatest();
    if (migrated.error) throw migrated.error;

    const user = async (label: string, roleId: string) =>
      (
        await db
          .insertInto('coms_auth.users')
          .values({
            email: `${label}@export.invalid`,
            full_name: 'Export ' + label,
            contact_number: 'export-' + label,
            hashed_password: 'test-only',
            role_id: roleId,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    const superRole = (
      await db
        .selectFrom('coms_auth.roles')
        .select('id')
        .where('code', '=', 'SUPER_ADMIN')
        .executeTakeFirstOrThrow()
    ).id;
    const limitedRole = (
      await db
        .insertInto('coms_auth.roles')
        .values({ code: 'NO_COSTS', role_name: 'No costs' })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    await sql`INSERT INTO coms_auth.role_permissions (role_id, permission_id)
      SELECT ${limitedRole}, id FROM coms_auth.permissions
      WHERE module_key = 'stock_items' AND action_key = 'read'`.execute(db);
    superAdmin = await user('admin', superRole);
    noCosts = await user('limited', limitedRole);
    supplier = (
      await db
        .insertInto('suppliers')
        .values({ supplier_name: 'Export Foods, Inc.' })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    const stock = async (stock_item_name: string, category: string) =>
      (
        await db
          .insertInto('stock_items')
          .values({ stock_item_name, category, unit: 'kg' })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    garlic = await stock('Export garlic', 'Export test');
    onion = await stock('=HYPERLINK("x"), onion', 'Export test');

    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DATABASE)
      .useValue(db)
      .overrideGuard(AuthGatewayGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(AuthGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          const req = ctx.switchToHttp().getRequest();
          req.user = { id: req.headers['x-test-actor'] };
          return true;
        },
      })
      .compile();
    app = module.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  }, 60000);

  afterAll(async () => {
    await app?.close();
    await db?.destroy();
    if (admin) {
      if (!name.startsWith('coms_export_test_')) throw Error('Unsafe cleanup');
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await admin.end();
    }
  });

  it('writes a safe spreadsheet file and records the download', async () => {
    const response = await as(superAdmin).get(
      '/costs/stock-items/export?search=HYPERLINK&page_size=10',
    );
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/^text\/csv/);
    expect(response.headers['content-disposition']).toBe(
      'attachment; filename="coms-stock-costs.csv"',
    );
    expect(response.text.charCodeAt(0)).toBe(0xfeff);
    const [header, row, end] = lines(response.text);
    expect(header).toMatch(/^Stock item,Category,Unit,Average cost/);
    expect(row).toBe(
      '"\'=HYPERLINK(""x""), onion",Export test,kg,,,,No cost yet',
    );
    expect(end).toBe('');
    const [event] = await exportEvents();
    expect(event).toMatchObject({
      actor_user_id: superAdmin,
      entity_type: 'export',
      entity_label: 'Stock costs',
    });
    expect(event.metadata).toEqual({
      file: 'coms-stock-costs.csv',
      rows: 1,
      filters: { search: 'HYPERLINK' },
    });
  });

  it('applies the list filters and read permission', async () => {
    const filtered = await as(superAdmin).get(
      '/inventory/commissary/export?category=Export%20test&search=garlic',
    );
    expect(filtered.status).toBe(200);
    expect(lines(filtered.text)).toEqual([
      'Stock item,Category,Unit,On hand,Reorder level,Target level,Status,Active',
      'Export garlic,Export test,kg,0,,,Out of stock,Yes',
      '',
    ]);
    expect((await as(noCosts).get('/costs/stock-items/export')).status).toBe(
      403,
    );
  });

  it('exports one row per supplier delivery line', async () => {
    const posted = await as(superAdmin)
      .post('/supplier-receipts')
      .set('Idempotency-Key', randomUUID())
      .send({
        supplier_id: supplier,
        received_at: '2026-10-01',
        items: [
          { stock_item_id: garlic, quantity_received: '2', unit_cost: '120' },
          { stock_item_id: onion, quantity_received: '1.5', unit_cost: '80' },
        ],
      });
    expect(posted.status).toBe(201);
    const response = await as(superAdmin).get(
      '/supplier-receipts/export?received_from=2026-10-01&received_to=2026-10-01',
    );
    expect(response.status).toBe(200);
    expect(response.headers['content-disposition']).toContain(
      'coms-supplier-deliveries-2026-10-01_2026-10-01.csv',
    );
    const rows = lines(response.text);
    expect(rows).toHaveLength(4);
    expect(rows.find((row) => row.includes('Export garlic'))).toMatch(
      /^2026-10-01,"Export Foods, Inc\.",Export garlic,kg,2(\.0+)?,120(\.0+)?,240(\.0+)?,Export admin,\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/,
    );
  });

  it('refuses exports above 50,000 rows', async () => {
    const branch = (
      await db
        .insertInto('branches')
        .values({ branch_name: 'Export Branch', code: 'EXP-01' })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    const purchase = await as(superAdmin)
      .post('/direct-purchases')
      .set('Idempotency-Key', randomUUID())
      .send({
        purchase_date: '2026-10-02',
        store_name: '+Puregold',
        receipt_number: 'PG-1',
        items: [
          { stock_item_id: garlic, quantity_received: '1', unit_cost: '13.25' },
        ],
      });
    expect(purchase.status, JSON.stringify(purchase.body)).toBe(201);
    const purchases = lines(
      (await as(superAdmin).get('/direct-purchases/export')).text,
    );
    expect(purchases[1]).toMatch(
      /^2026-10-02,'\+Puregold,PG-1,Export garlic,kg,1(\.0+)?,13\.25(0+)?,13\.25(0+)?,Export admin$/,
    );
    await db
      .insertInto('branch_inventory')
      .values({ branch_id: branch, stock_item_id: garlic })
      .execute();
    // Stock items count only for business days after they were created.
    const today = new Date(Date.now() + 8 * 3600_000)
      .toISOString()
      .slice(0, 10);
    const report = await as(superAdmin)
      .post(`/branches/${branch}/daily-reports`)
      .set('Idempotency-Key', randomUUID())
      .send({ business_date: today });
    expect(report.status, JSON.stringify(report.body)).toBe(201);
    const reportRows = lines(
      (await as(superAdmin).get(`/branches/${branch}/daily-reports/export`))
        .text,
    );
    expect(reportRows.length).toBeGreaterThan(2);
    expect(reportRows[1]).toMatch(
      new RegExp(`^${today},Draft,Export garlic,kg,`),
    );

    const exports: [string, string][] = [
      [`/branches/${branch}/sales/export`, 'Sale,Date and time'],
      [`/branches/${branch}/daily-reports/export`, 'Business day,'],
      [`/inventory/branches/${branch}/export`, 'Stock item,'],
      [`/inventory/branches/${branch}/movements/export`, 'Date and time,'],
      ['/inventory/commissary/movements/export', 'Date and time,'],
      ['/direct-purchases/export', 'Purchased on,'],
      ['/costs/branches/export', 'Branch,Sales'],
      ['/costs/branch-products/export', 'Product,Units sold'],
      ['/costs/products/export', 'Product,Category'],
    ];
    for (const [path, header] of exports) {
      const response = await as(superAdmin).get(path);
      expect(response.status, path).toBe(200);
      expect(lines(response.text)[0], path).toMatch(new RegExp('^' + header));
    }
    expect(
      (await as(superAdmin).get(`/branches/${branch}/sales/export`)).headers[
        'content-disposition'
      ],
    ).toContain('coms-sales-exp-01-all-dates.csv');

    await sql`INSERT INTO stock_items (stock_item_name, category, unit)
      SELECT 'Bulk item ' || n, 'Bulk', 'pcs' FROM generate_series(1, 50001) AS n`.execute(
      db,
    );
    const before = (await exportEvents()).length;
    const response = await as(superAdmin).get(
      '/inventory/commissary/export?category=Bulk',
    );
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'EXPORT_TOO_LARGE' });
    expect(response.body.message).toContain('50,001 rows');
    expect(await exportEvents()).toHaveLength(before);
  }, 60000);
});
