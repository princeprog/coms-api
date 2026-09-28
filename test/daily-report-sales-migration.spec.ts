import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as migration from '../src/database/migrations/20260928225746_daily_report_sales_summary';

describe.skipIf(process.env.COMS_RUN_DB_TESTS !== '1')(
  'daily report sales summary migration',
  () => {
    const databaseName = `coms_report_sales_migration_${randomUUID().replaceAll('-', '')}`;
    const reportId = randomUUID();
    const submittedReportId = randomUUID();
    const emptyReportId = randomUUID();
    const branchId = randomUUID();
    const completedSaleId = randomUUID();
    const submittedSaleId = randomUUID();
    let admin: Pool | undefined;
    let testDb: Kysely<any> | undefined;

    beforeAll(async () => {
      const source =
        process.env.COMS_TEST_ADMIN_URL ??
        parse(readFileSync('.env')).DATABASE_URL;
      const url = new URL(source);
      admin = new Pool({ connectionString: url.toString() });
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      url.pathname = `/${databaseName}`;
      testDb = new Kysely({
        dialect: new PostgresDialect({
          pool: new Pool({ connectionString: url.toString() }),
        }),
      });
      await sql`
        CREATE TABLE daily_branch_reports (
          id uuid PRIMARY KEY,
          branch_id uuid NOT NULL,
          business_date date NOT NULL,
          status varchar(24) NOT NULL,
          submitted_at timestamptz,
          reviewed_at timestamptz
        )
      `.execute(testDb);
      await sql`
        CREATE TABLE sales (
          id uuid PRIMARY KEY,
          branch_id uuid NOT NULL,
          total_amount numeric NOT NULL
        )
      `.execute(testDb);
      await sql`
        CREATE TABLE sale_events (
          id uuid PRIMARY KEY,
          sale_id uuid NOT NULL,
          event_type varchar(24) NOT NULL,
          created_at timestamptz NOT NULL
        )
      `.execute(testDb);
      await sql`
        INSERT INTO daily_branch_reports
          (id, branch_id, business_date, status, reviewed_at)
        VALUES
          (${reportId}, ${branchId}, '2026-09-27', 'APPROVED', '2026-09-28T05:00:00Z'),
          (${submittedReportId}, ${branchId}, '2026-09-28', 'SUBMITTED', '2026-09-29T02:00:00Z'),
          (${emptyReportId}, ${branchId}, '2026-09-26', 'DRAFT', NULL)
      `.execute(testDb);
      await sql`
        INSERT INTO sales (id, branch_id, total_amount)
        VALUES (${completedSaleId}, ${branchId}, 125.50),
               (${submittedSaleId}, ${branchId}, 30.00)
      `.execute(testDb);
      await sql`
        INSERT INTO sale_events (id, sale_id, event_type, created_at)
        VALUES
          (${randomUUID()}, ${completedSaleId}, 'COMPLETED', '2026-09-27T03:00:00Z'),
          (${randomUUID()}, ${completedSaleId}, 'VOIDED', '2026-09-27T06:00:00Z'),
          (${randomUUID()}, ${submittedSaleId}, 'COMPLETED', '2026-09-28T01:00:00Z'),
          (${randomUUID()}, ${submittedSaleId}, 'VOIDED', '2026-09-28T02:00:00Z')
      `.execute(testDb);
      await migration.up(testDb);
    }, 30000);

    afterAll(async () => {
      if (testDb) await testDb.destroy();
      if (admin) {
        await admin.query(
          `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`,
        );
        await admin.end();
      }
    });

    it('backfills each report from Manila business-day sale events and guards rollback', async () => {
      const defaults = await sql<{
        completed_sales_amount: string;
        completed_sales_count: number;
        voided_sales_amount: string;
        voided_sales_count: number;
      }>`
        SELECT completed_sales_amount::text, completed_sales_count,
               voided_sales_amount::text, voided_sales_count
        FROM daily_branch_reports WHERE id = ${reportId}
      `.execute(testDb!);
      expect(defaults.rows[0]).toEqual({
        completed_sales_amount: '125.50',
        completed_sales_count: 1,
        voided_sales_amount: '125.50',
        voided_sales_count: 1,
      });

      const submitted = await sql<{
        completed_sales_amount: string;
        completed_sales_count: number;
        voided_sales_amount: string;
        voided_sales_count: number;
      }>`
        SELECT completed_sales_amount::text, completed_sales_count,
               voided_sales_amount::text, voided_sales_count
        FROM daily_branch_reports WHERE id = ${submittedReportId}
      `.execute(testDb!);
      expect(submitted.rows[0]).toEqual({
        completed_sales_amount: '30.00',
        completed_sales_count: 1,
        voided_sales_amount: '30.00',
        voided_sales_count: 1,
      });

      const empty = await sql<{
        completed_sales_amount: string;
        completed_sales_count: number;
        voided_sales_amount: string;
        voided_sales_count: number;
      }>`
        SELECT completed_sales_amount::text, completed_sales_count,
               voided_sales_amount::text, voided_sales_count
        FROM daily_branch_reports WHERE id = ${emptyReportId}
      `.execute(testDb!);
      expect(empty.rows[0]).toEqual({
        completed_sales_amount: '0',
        completed_sales_count: 0,
        voided_sales_amount: '0',
        voided_sales_count: 0,
      });

      await sql`
        UPDATE daily_branch_reports SET completed_sales_amount = 125.50
        WHERE id = ${reportId}
      `.execute(testDb!);
      await expect(migration.down(testDb!)).rejects.toThrow(
        'Cannot roll back daily report sales snapshots while saved sales totals exist.',
      );
      const preserved = await sql<{ total: string }>`
        SELECT completed_sales_amount::text AS total
        FROM daily_branch_reports WHERE id = ${reportId}
      `.execute(testDb!);
      expect(preserved.rows[0]?.total).toBe('125.50');

      await sql`
        UPDATE daily_branch_reports
        SET completed_sales_amount = 0, completed_sales_count = 0,
            voided_sales_amount = 0, voided_sales_count = 0
        WHERE id IN (${reportId}, ${submittedReportId})
      `.execute(testDb!);
      await migration.down(testDb!);
      const columns = await sql<{ count: number }>`
        SELECT count(*)::int AS count FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'daily_branch_reports'
          AND column_name IN ('completed_sales_amount', 'completed_sales_count',
            'voided_sales_amount', 'voided_sales_count')
      `.execute(testDb!);
      expect(columns.rows[0]?.count).toBe(0);
    });
  },
);
