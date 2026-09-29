import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import { Kysely, PostgresDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as initial from '../src/database/migrations/20260920174538_auth';
import * as rotation from '../src/database/migrations/20260921120000_auth_token_rotation';
import * as limits from '../src/database/migrations/20260922164052_auth_rate_limits';
import * as accessControl from '../src/database/migrations/20260923214210_access_control';
import * as catalogs from '../src/database/migrations/20260924004212_operational_catalogs';
import type { DB } from '../src/database/db';
import { ProductsRepository } from '../src/modules/products/products.repository';

vi.mock('../src/database/database.module', () => ({
  DATABASE: Symbol('TEST_DATABASE'),
}));

describe.skipIf(process.env.COMS_RUN_DB_TESTS !== '1')(
  'paginated product queries',
  () => {
    const databaseName = `coms_pagination_test_${randomUUID().replaceAll('-', '')}`;
    let admin: Pool | undefined;
    let db: Kysely<DB> | undefined;

    beforeAll(async () => {
      const source =
        process.env.COMS_TEST_ADMIN_URL ??
        parse(readFileSync('.env')).DATABASE_URL;
      const url = new URL(source);
      admin = new Pool({ connectionString: url.toString() });
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      url.pathname = `/${databaseName}`;
      db = new Kysely<DB>({
        dialect: new PostgresDialect({
          pool: new Pool({ connectionString: url.toString() }),
        }),
      });
      const migrator = new Migrator({
        db,
        provider: {
          getMigrations: async () => ({
            '20260920174538_auth': initial,
            '20260921120000_auth_token_rotation': rotation,
            '20260922164052_auth_rate_limits': limits,
            '20260923214210_access_control': accessControl,
            '20260924004212_operational_catalogs': catalogs,
          }),
        },
      });
      expect((await migrator.migrateToLatest()).error).toBeUndefined();
      await db
        .insertInto('products')
        .values(
          Array.from({ length: 65 }, (_, index) => ({
            product_name: `Product ${String(index + 1).padStart(2, '0')}`,
            description: null,
          })),
        )
        .execute();
      await db
        .insertInto('products')
        .values({ product_name: 'Special_% product', description: null })
        .execute();
    }, 30000);

    afterAll(async () => {
      if (db) await db.destroy();
      if (admin) {
        await admin.query(
          `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`,
        );
        await admin.end();
      }
    });

    it.each([10, 20, 50])(
      'returns page 2 with %i products per page',
      async (pageSize) => {
        const result = await new ProductsRepository(db!).list({
          page: 2,
          page_size: pageSize,
        });

        expect(result.page).toBe(2);
        expect(result.page_size).toBe(pageSize);
        expect(result.total).toBe(66);
        expect(result.items).toHaveLength(Math.min(pageSize, 66 - pageSize));
        expect(result.items[0].product_name).toBe(
          `Product ${String(pageSize + 1).padStart(2, '0')}`,
        );
      },
    );

    it('counts only filtered records and treats search wildcards literally', async () => {
      const result = await new ProductsRepository(db!).list({
        page: 1,
        page_size: 10,
        search: '_%',
      });

      expect(result.total).toBe(1);
      expect(result.items.map((item) => item.product_name)).toEqual([
        'Special_% product',
      ]);
    });
  },
);
