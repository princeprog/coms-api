import '../src/config/load-env';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { Pool } from 'pg';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe.skipIf(process.env.COMS_RUN_DB_TESTS !== '1')(
  'global product price migration',
  () => {
    let admin: Pool, db: Kysely<any>, migrator: Migrator, name: string;
    beforeEach(async () => {
      const url = new URL(
        process.env.COMS_TEST_ADMIN_URL ?? process.env.DATABASE_URL!,
      );
      if (!['localhost', '127.0.0.1'].includes(url.hostname))
        throw Error('Use loopback');
      name = 'coms_simple_migration_' + randomUUID().replaceAll('-', '');
      admin = new Pool({ connectionString: url.toString() });
      await admin.query(`CREATE DATABASE "${name}"`);
      url.pathname = '/' + name;
      db = new Kysely({
        dialect: new PostgresDialect({
          pool: new Pool({ connectionString: url.toString() }),
        }),
      });
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
    afterEach(async () => {
      await db?.destroy();
      if (admin) {
        if (!name.startsWith('coms_simple_migration_'))
          throw Error('Unsafe cleanup');
        await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
        await admin.end();
      }
    });
    const seed = async (prices: string[]) => {
      const product = (
        await db
          .insertInto('products')
          .values({ product_name: 'Legacy exact product' })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      const actor = (
        await db
          .insertInto('auth.users')
          .values({
            full_name: 'Historical operator',
            email: 'history@migration.invalid',
            contact_number: 'historical',
            hashed_password: 'test-only',
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      let branch: string | undefined;
      for (const [index, price] of prices.entries()) {
        branch = (
          await db
            .insertInto('branches')
            .values({
              code: 'MIGRATION-' + index,
              branch_name: 'Migration ' + index,
            })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;
        await db
          .insertInto('branch_product_prices')
          .values({
            branch_id: branch,
            product_id: product,
            price,
            revision: 3,
            updated_by_user_id: actor,
          })
          .execute();
        await db
          .insertInto('branch_products')
          .values({
            branch_id: branch,
            product_id: product,
            price,
            is_available: index === 0,
          })
          .execute();
      }
      return { product, actor, branch };
    };
    it('copies consistent exact prices and marks old sales without changing history', async () => {
      const { product, actor, branch } = await seed([
        '19.123456789',
        '19.123456789',
      ]);
      const sale = await db
        .insertInto('sales')
        .values({
          branch_id: branch!,
          cashier_user_id: actor,
          status: 'COMPLETED',
          tender_method: 'CASH',
          total_amount: '19.123456789',
          idempotency_key: randomUUID(),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      const offers = await db
        .selectFrom('branch_products')
        .selectAll()
        .orderBy('branch_id')
        .execute();
      const result = await migrator.migrateToLatest();
      expect(result.error).toBeUndefined();
      const current = await db
        .selectFrom('products')
        .selectAll()
        .where('id', '=', product)
        .executeTakeFirstOrThrow();
      expect(current.price).toBe('19.123456789');
      expect(current.price_revision).toBe(3);
      expect(
        await db
          .selectFrom('branch_products')
          .selectAll()
          .orderBy('branch_id')
          .execute(),
      ).toEqual(offers);
      expect(
        await db
          .selectFrom('sales')
          .selectAll()
          .where('id', '=', sale.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ ...sale, inventory_deducted: true });
      const down = await migrator.migrateDown();
      expect(down.error).toBeUndefined();
    });
    it('stops for missing prices and preserves the schema atomically', async () => {
      await seed([]);
      const result = await migrator.migrateToLatest();
      expect(result.error).toBeDefined();
      expect(String(result.error)).toContain('explicit selling price');
      const columns = await sql<{
        count: string;
      }>`SELECT count(*)::text FROM information_schema.columns WHERE table_schema='public' AND table_name='products' AND column_name='price'`.execute(
        db,
      );
      expect(columns.rows[0].count).toBe('0');
    });
    it('stops for conflicting branch prices without choosing one', async () => {
      await seed(['19.99', '20']);
      const result = await migrator.migrateToLatest();
      expect(result.error).toBeDefined();
      expect(String(result.error)).toContain('explicit selling price');
    });
    it('uses false for new sales and guards rollback after financial-only sales', async () => {
      const { actor, branch } = await seed(['19']);
      const result = await migrator.migrateToLatest();
      expect(result.error).toBeUndefined();
      const sale = await db
        .insertInto('sales')
        .values({
          branch_id: branch!,
          cashier_user_id: actor,
          status: 'COMPLETED',
          tender_method: 'CASH',
          total_amount: '19',
          idempotency_key: randomUUID(),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      expect(sale.inventory_deducted).toBe(false);
      const down = await migrator.migrateDown();
      expect(down.error).toBeDefined();
      expect(String(down.error)).toContain('forward correction');
    });
  },
);
