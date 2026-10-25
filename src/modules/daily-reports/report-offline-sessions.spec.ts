import { Kysely, PostgresDialect, type CompiledQuery } from 'kysely';
import type { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '../../database/db';
import { DailyReportsRepository } from './daily-reports.repository';
import { NotificationWriterRepository } from '../notifications/notification-writer.repository';

vi.mock('../../database/database.module', () => ({
  DATABASE: Symbol('DATABASE'),
}));

afterEach(() => vi.unstubAllEnvs());

describe('daily report offline guard', () => {
  it.each([
    ['submit', 'DRAFT', 'test'],
    ['submit', 'RETURNED', 'development'],
    ['approve', 'SUBMITTED', 'test'],
    ['approve', 'SUBMITTED', 'development'],
  ] as const)(
    'blocks %s from %s even in %s before writes',
    async (action, status, environment) => {
      vi.stubEnv('NODE_ENV', environment);
      const queries: { sql: string; parameters: readonly unknown[] }[] = [];
      const db = new Kysely<DB>({
        dialect: new PostgresDialect({
          pool: {
            connect: async () => ({
              query: async (
                text: string,
                parameters: CompiledQuery['parameters'],
              ) => {
                queries.push({ sql: text, parameters });
                return {
                  rows: text.includes('pos_offline_sessions')
                    ? [{ id: 'offline-session' }]
                    : text.includes('from "daily_branch_reports"')
                      ? [{ id: 'report', status, business_date: '2026-09-23' }]
                      : text.includes('from "branches"')
                        ? [{ id: 'branch' }]
                        : [],
                };
              },
              release: () => {},
            }),
            end: async () => {},
          } as unknown as Pool,
        }),
      });
      try {
        const reports = new DailyReportsRepository(
          db,
          new NotificationWriterRepository(),
        );
        await expect(
          reports[action]('branch', 'report', 'actor'),
        ).rejects.toMatchObject({
          response: { code: 'OFFLINE_SYNC_REQUIRED' },
        });
        const advisory = queries.findIndex((query) =>
          query.sql.includes('pg_advisory_xact_lock'),
        );
        const reportLock = queries.findIndex(
          (query) =>
            query.sql.includes('from "daily_branch_reports"') &&
            query.sql.includes('for update'),
        );
        const branchLock = queries.findIndex(
          (query) =>
            query.sql.includes('from "branches"') &&
            query.sql.includes('for update'),
        );
        const guard = queries.findIndex((query) =>
          query.sql.includes('pos_offline_sessions'),
        );
        expect(advisory).toBeGreaterThan(-1);
        expect(branchLock).toBeGreaterThan(advisory);
        expect(reportLock).toBeGreaterThan(branchLock);
        expect(guard).toBeGreaterThan(reportLock);
        expect(queries[guard].parameters).toEqual(['branch', '2026-09-23']);
        expect(
          queries.some((query) =>
            /^(update|insert|delete)/i.test(query.sql.trim()),
          ),
        ).toBe(false);
        expect(queries.at(-1)?.sql).toBe('rollback');
      } finally {
        await db.destroy();
      }
    },
  );
});
