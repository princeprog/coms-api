import '../src/config/load-env';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DB } from '../src/database/db';
import { down as rollbackSchema } from '../src/database/migrations/20261008004901_branch_menu_service_schema';
import { down as rollbackPermissions } from '../src/database/migrations/20261008004902_branch_menu_permissions';

const backup = process.env.COMS_MENU_UPGRADE_BACKUP;
describe.skipIf(process.env.COMS_RUN_DB_TESTS !== '1' || !backup)(
  'menu upgrade from a verified development backup',
  () => {
    const name = 'coms_menu_upgrade_test_' + randomUUID().replaceAll('-', '');
    let admin: Pool, db: Kysely<DB>, migrator: Migrator;
    let branch: string,
      product: string,
      stock: string,
      actor: string,
      sale: string,
      role: string;
    let oldGrants: { permission_id: string }[], oldConsumption: unknown[];
    beforeAll(async () => {
      if (!backup || !existsSync(backup))
        throw new Error('A verified development backup is required');
      const url = new URL(
        process.env.COMS_TEST_ADMIN_URL ?? process.env.DATABASE_URL!,
      );
      if (!['localhost', '127.0.0.1'].includes(url.hostname))
        throw new Error('Use a verified local development target');
      admin = new Pool({ connectionString: url.toString() });
      await admin.query(`CREATE DATABASE "${name}"`);
      execFileSync(
        process.env.COMS_PG_RESTORE ??
          'C:\\Program Files\\PostgreSQL\\18\\bin\\pg_restore.exe',
        [
          '--exit-on-error',
          '--host',
          url.hostname,
          '--port',
          url.port || '5432',
          '--username',
          decodeURIComponent(url.username),
          '--dbname',
          name,
          backup,
        ],
        {
          env: { ...process.env, PGPASSWORD: decodeURIComponent(url.password) },
          stdio: 'pipe',
        },
      );
      url.pathname = '/' + name;
      db = new Kysely<DB>({
        dialect: new PostgresDialect({
          pool: new Pool({ connectionString: url.toString() }),
        }),
      });
      actor = (
        await db.selectFrom('auth.users').select('id').executeTakeFirstOrThrow()
      ).id;
      role = (
        await db
          .insertInto('auth.roles')
          .values({ code: 'MENU_CUSTOM_TEST', role_name: 'Menu custom test' })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      const read = await db
        .selectFrom('auth.permissions')
        .select('id')
        .where('module_key', '=', 'products')
        .where('action_key', '=', 'read')
        .executeTakeFirstOrThrow();
      await db
        .insertInto('auth.role_permissions')
        .values({ role_id: role, permission_id: read.id })
        .execute();
      oldGrants = await db
        .selectFrom('auth.role_permissions')
        .select('permission_id')
        .where('role_id', '=', role)
        .execute();
      branch = (
        await db
          .insertInto('branches')
          .values({
            code: 'MENU-LEGACY-TEST',
            branch_name: 'Synthetic legacy menu',
            has_dine_in: false,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      product = (
        await db
          .insertInto('products')
          .values({ product_name: 'Synthetic legacy meal' } as never)
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      stock = (
        await db
          .insertInto('stock_items')
          .values({
            stock_item_name: 'Synthetic legacy ingredient',
            category: 'Other',
            unit: 'kg',
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      await sql`INSERT INTO product_ingredients(product_id,stock_item_id,quantity_required) VALUES (${product}::uuid,${stock}::uuid,0.0250)`.execute(
        db,
      );
      await sql`INSERT INTO branch_products(branch_id,product_id,price) VALUES (${branch}::uuid,${product}::uuid,9.00750)`.execute(
        db,
      );
      sale = (
        await sql<{
          id: string;
        }>`INSERT INTO sales(branch_id,cashier_user_id,status,tender_method,total_amount,idempotency_key) VALUES (${branch}::uuid,${actor}::uuid,'COMPLETED','cash',18.01500,${randomUUID()}::uuid) RETURNING id`.execute(
          db,
        )
      ).rows[0].id;
      const item = (
        await sql<{
          id: string;
        }>`INSERT INTO sale_items(sale_id,product_id,product_name_snapshot,quantity,unit_price,line_total) VALUES (${sale}::uuid,${product}::uuid,'Synthetic legacy meal',2,9.00750,18.01500) RETURNING id`.execute(
          db,
        )
      ).rows[0].id;
      await sql`INSERT INTO sale_item_consumptions(sale_item_id,stock_item_id,quantity_consumed) VALUES (${item}::uuid,${stock}::uuid,0.0500)`.execute(
        db,
      );
      oldConsumption = await db
        .selectFrom('sale_item_consumptions')
        .selectAll()
        .orderBy('id')
        .execute();
      const migrations: Record<string, unknown> = {};
      for (const file of readdirSync('src/database/migrations')
        .filter((file) => file.endsWith('.ts'))
        .sort())
        migrations[file.slice(0, -3)] = await import(
          '../src/database/migrations/' + file
        );
      migrator = new Migrator({
        db,
        provider: { getMigrations: async () => migrations as never },
      });
      const result = await migrator.migrateTo(
        '20261008004902_branch_menu_permissions',
      );
      if (result.error) throw result.error;
    }, 30000);
    afterAll(async () => {
      if (db) await db.destroy();
      if (admin) {
        if (!name.startsWith('coms_menu_upgrade_test_'))
          throw new Error('Unsafe test cleanup');
        await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
        await admin.end();
      }
    });
    it('backfills exact prices, all-service ingredients and takeout capability without changing historical sale snapshots', async () => {
      const price = await db
        .selectFrom('branch_product_prices')
        .selectAll()
        .where('branch_id', '=', branch)
        .where('product_id', '=', product)
        .executeTakeFirstOrThrow();
      expect(price.price).toBe('9.00750');
      expect(price.revision).toBe(1);
      expect(
        (
          await db
            .selectFrom('product_ingredients')
            .selectAll()
            .where('product_id', '=', product)
            .executeTakeFirstOrThrow()
        ).usage_scope,
      ).toBe('ALL');
      expect(
        (
          await db
            .selectFrom('branches')
            .selectAll()
            .where('id', '=', branch)
            .executeTakeFirstOrThrow()
        ).has_takeaway,
      ).toBe(true);
      expect(
        (
          await db
            .selectFrom('sales')
            .selectAll()
            .where('id', '=', sale)
            .executeTakeFirstOrThrow()
        ).service_type,
      ).toBeNull();
      expect(
        await db
          .selectFrom('sale_item_consumptions')
          .selectAll()
          .orderBy('id')
          .execute(),
      ).toEqual(oldConsumption);
      expect(
        await db
          .selectFrom('auth.role_permissions')
          .select('permission_id')
          .where('role_id', '=', role)
          .execute(),
      ).toEqual(oldGrants);
    });
    it('guards schema and permission rollback when new rollout data or later custom grants exist', async () => {
      await db
        .updateTable('branches')
        .set({ has_takeaway: false, has_dine_in: true })
        .where('id', '=', branch)
        .execute();
      await expect(
        db.transaction().execute((tx) => rollbackSchema(tx)),
      ).rejects.toBeInstanceOf(Error);
      await db
        .updateTable('branches')
        .set({ has_takeaway: true })
        .where('id', '=', branch)
        .execute();
      const permission = await db
        .selectFrom('auth.permissions')
        .select('id')
        .where('module_key', '=', 'menu_requests')
        .where('action_key', '=', 'read')
        .executeTakeFirstOrThrow();
      await db
        .insertInto('auth.role_permissions')
        .values({ role_id: role, permission_id: permission.id })
        .execute();
      await expect(
        db.transaction().execute((tx) => rollbackPermissions(tx)),
      ).rejects.toBeInstanceOf(Error);
      await db
        .deleteFrom('auth.role_permissions')
        .where('role_id', '=', role)
        .where('permission_id', '=', permission.id)
        .execute();
    });
    it('safely rolls back an untouched upgrade and reapplies it with legacy prices intact', async () => {
      let result = await migrator.migrateDown();
      if (result.error) throw result.error;
      result = await migrator.migrateDown();
      if (result.error) throw result.error;
      const legacy = await sql<{
        price: string;
      }>`SELECT price::text FROM branch_products WHERE branch_id=${branch}::uuid AND product_id=${product}::uuid`.execute(
        db,
      );
      expect(legacy.rows[0].price).toBe('9.00750');
      result = await migrator.migrateTo(
        '20261008004902_branch_menu_permissions',
      );
      if (result.error) throw result.error;
      expect(
        (
          await db
            .selectFrom('branch_product_prices')
            .select('price')
            .where('branch_id', '=', branch)
            .where('product_id', '=', product)
            .executeTakeFirstOrThrow()
        ).price,
      ).toBe('9.00750');
    });
  },
);
