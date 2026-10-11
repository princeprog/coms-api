import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { parse } from 'dotenv';
import { Kysely, PostgresDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DB } from '../src/database/db';
import { ProductsRepository } from '../src/modules/products/products.repository';
import { BranchesRepository } from '../src/modules/branches/branches.repository';
import { BranchesService } from '../src/modules/branches/branches.service';
import { BadRequestException } from '@nestjs/common';

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
          getMigrations: async () =>
            Object.fromEntries(
              await Promise.all(
                readdirSync('src/database/migrations')
                  .filter((file) => file.endsWith('.ts'))
                  .sort()
                  .map(async (file) => [
                    file.slice(0, -3),
                    await import('../src/database/migrations/' + file),
                  ]),
              ),
            ),
        },
      });
      expect((await migrator.migrateToLatest()).error).toBeUndefined();
      await db
        .insertInto('products')
        .values(
          Array.from({ length: 65 }, (_, index) => ({
            price: '1.00',
            product_name: `Product ${String(index + 1).padStart(2, '0')}`,
            description: null,
          })),
        )
        .execute();
      await db
        .insertInto('products')
        .values({
          price: '1.00',
          product_name: 'Special_% product',
          description: null,
        })
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

    it('searches branches before pagination, escapes wildcards and retains authorized scope', async () => {
      const branches = await db!
        .insertInto('branches')
        .values([
          { code: 'SEARCH-MAIN', branch_name: 'Main branch' },
          { code: 'SEARCH-MARKET', branch_name: 'Market branch' },
          { code: 'SEARCH-LITERAL', branch_name: 'Market_% branch' },
        ])
        .returning('id')
        .execute();
      const repository = new BranchesRepository(db!);
      const matches = await repository.list(1, 1, undefined, 'market');
      expect(matches.total).toBe(2);
      expect(matches.items).toHaveLength(1);
      const literal = await repository.list(1, 25, undefined, '_%');
      expect(literal.items.map((b) => b.branch_name)).toEqual([
        'Market_% branch',
      ]);
      const scoped = await repository.list(1, 25, [branches[0].id], 'market');
      expect(scoped.total).toBe(0);
      expect(scoped.items).toEqual([]);
    });

    it('combines branch status and service filters before sorting, counting and pagination', async () => {
      const rows = await db!
        .insertInto('branches')
        .values([
          {
            code: 'DIRECTORY-A',
            branch_name: 'Directory Alpha',
            has_dine_in: true,
            has_takeaway: false,
            date_opened: '2024-01-15',
          },
          {
            code: 'DIRECTORY-B',
            branch_name: 'Directory Beta',
            has_dine_in: true,
            has_takeaway: true,
            date_opened: '2025-01-15',
          },
          {
            code: 'DIRECTORY-C',
            branch_name: 'Directory Charlie',
            has_dine_in: false,
            has_takeaway: true,
            status: 'inactive',
          },
        ])
        .returning('id')
        .execute();
      const repository = new BranchesRepository(db!);
      const result = await repository.list(1, 1, undefined, 'Directory', {
        status: 'active',
        service_type: 'DINE_IN',
        sort_by: 'date_opened',
        sort_order: 'desc',
      });
      expect(result.total).toBe(2);
      expect(result.items.map((b) => b.branch_name)).toEqual([
        'Directory Beta',
      ]);
      const second = await repository.list(2, 1, undefined, 'Directory', {
        status: 'active',
        service_type: 'DINE_IN',
        sort_by: 'date_opened',
        sort_order: 'desc',
      });
      expect(second.items.map((b) => b.branch_name)).toEqual([
        'Directory Alpha',
      ]);
      const scoped = await repository.list(1, 25, [rows[0].id], 'Directory', {
        service_type: 'TAKEAWAY',
      });
      expect(scoped.total).toBe(0);
      expect(scoped.items).toEqual([]);
      const inactive = await repository.list(1, 25, undefined, 'Directory', {
        status: 'inactive',
        service_type: 'TAKEAWAY',
      });
      expect(inactive.items.map((b) => b.branch_name)).toEqual([
        'Directory Charlie',
      ]);
    });

    it('persists branch edits and service choices while retaining the permanent code', async () => {
      const repository = new BranchesRepository(db!);
      const service = new BranchesService(repository);
      const branch = await repository.create({
        code: 'EDIT-CODE',
        branch_name: 'Before edit',
      });
      const updated = await service.update(branch.id, {
        branch_name: 'After edit',
        address: 'Test Avenue',
        date_opened: '2024-01-15',
        has_dine_in: true,
        has_takeaway: false,
      });
      expect(updated).toMatchObject({
        code: 'EDIT-CODE',
        branch_name: 'After edit',
        address: 'Test Avenue',
        has_dine_in: true,
        has_takeaway: false,
      });
      await expect(
        service.update(branch.id, { has_dine_in: false, has_takeaway: false }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect((await repository.findById(branch.id))?.has_dine_in).toBe(true);
      await service.deactivate(branch.id);
      expect(
        (
          await service.update(branch.id, {
            has_dine_in: false,
            has_takeaway: false,
          })
        ).status,
      ).toBe('inactive');
    });
  },
);
