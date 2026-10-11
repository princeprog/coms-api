import '../src/config/load-env';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { down } from '../src/database/migrations/20261010174904_stock_usage_product_setup';
const backup = process.env.COMS_SETUP_UPGRADE_BACKUP;
describe.skipIf(process.env.COMS_RUN_DB_TESTS !== '1' || !backup)(
  'product setup upgrade preserves existing recipes and sale snapshots',
  () => {
    const name = 'coms_setup_restore_test_' + randomUUID().replaceAll('-', '');
    let admin: Pool, db: Kysely<any>, migrator: Migrator, before: unknown[];
    let stock: string, unused: string, product: string;
    beforeAll(async () => {
      const url = new URL(process.env.DATABASE_URL!);
      if (!['localhost', '127.0.0.1'].includes(url.hostname))
        throw Error('Unexpected target');
      admin = new Pool({ connectionString: url.toString() });
      await admin.query(`CREATE DATABASE "${name}"`);
      execFileSync(
        'C:\\Program Files\\PostgreSQL\\18\\bin\\pg_restore.exe',
        [
          '--exit-on-error',
          '-h',
          url.hostname,
          '-p',
          url.port || '5432',
          '-U',
          decodeURIComponent(url.username),
          '-d',
          name,
          backup!,
        ],
        {
          env: { ...process.env, PGPASSWORD: decodeURIComponent(url.password) },
          stdio: 'pipe',
        },
      );
      url.pathname = '/' + name;
      db = new Kysely({
        dialect: new PostgresDialect({
          pool: new Pool({ connectionString: url.toString() }),
        }),
      });
      stock = (
        await sql<{
          id: string;
        }>`INSERT INTO stock_items(stock_item_name,category,unit) VALUES('Legacy recipe stock','Other','pcs') RETURNING id`.execute(
          db,
        )
      ).rows[0].id;
      unused = (
        await sql<{
          id: string;
        }>`INSERT INTO stock_items(stock_item_name,category,unit) VALUES('Legacy unused stock','Other','pcs') RETURNING id`.execute(
          db,
        )
      ).rows[0].id;
      product = (
        await sql<{
          id: string;
        }>`INSERT INTO products(product_name,recipe_revision) VALUES('Legacy setup product',1) RETURNING id`.execute(
          db,
        )
      ).rows[0].id;
      await sql`INSERT INTO product_ingredients(product_id,stock_item_id,quantity_required) VALUES(${product}::uuid,${stock}::uuid,0.123456789)`.execute(
        db,
      );
      before = (
        await sql`SELECT row_to_json(c) AS row FROM sale_item_consumptions c ORDER BY id`.execute(
          db,
        )
      ).rows;
      const migrations: Record<string, unknown> = {};
      for (const file of readdirSync('src/database/migrations')
        .filter((f) => f.endsWith('.ts'))
        .sort())
        migrations[file.slice(0, -3)] = await import(
          '../src/database/migrations/' + file
        );
      migrator = new Migrator({
        db,
        provider: { getMigrations: async () => migrations as never },
      });
      const result = await migrator.migrateTo(
        '20261010174904_stock_usage_product_setup',
      );
      if (result.error) throw result.error;
    }, 30000);
    afterAll(async () => {
      await db?.destroy();
      if (admin) {
        if (!name.startsWith('coms_setup_restore_test_'))
          throw Error('Unsafe cleanup');
        await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
        await admin.end();
      }
    });
    it('backfills actual recipe use, keeps exact quantities and immutable snapshots', async () => {
      const stocks = await sql<{
        id: string;
        usage_types: string[];
      }>`SELECT id,usage_types FROM stock_items WHERE id IN (${stock}::uuid,${unused}::uuid)`.execute(
        db,
      );
      expect(stocks.rows.find((s) => s.id === stock)?.usage_types).toEqual([
        'INGREDIENT',
      ]);
      expect(stocks.rows.find((s) => s.id === unused)?.usage_types).toEqual([
        'OPERATING_SUPPLY',
      ]);
      const recipe = await sql<{
        quantity: string;
        component_type: string;
      }>`SELECT trim_scale(quantity_required)::text AS quantity,component_type FROM product_ingredients WHERE product_id=${product}::uuid`.execute(
        db,
      );
      expect(recipe.rows[0]).toEqual({
        quantity: '0.123456789',
        component_type: 'INGREDIENT',
      });
      expect(
        (
          await sql`SELECT row_to_json(c) AS row FROM sale_item_consumptions c ORDER BY id`.execute(
            db,
          )
        ).rows,
      ).toEqual(before);
    });
    it('rolls back untouched migration data, reapplies and guards custom classifications', async () => {
      const reverted = await migrator.migrateDown();
      expect(reverted.error).toBeUndefined();
      const applied = await migrator.migrateTo(
        '20261010174904_stock_usage_product_setup',
      );
      expect(applied.error).toBeUndefined();
      await sql`UPDATE stock_items SET usage_types=ARRAY['PACKAGING'] WHERE id=${unused}::uuid`.execute(
        db,
      );
      await expect(db.transaction().execute((tx) => down(tx))).rejects.toThrow(
        'forward correction',
      );
    });
  },
);
