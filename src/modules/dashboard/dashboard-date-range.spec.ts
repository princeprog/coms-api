import { describe, expect, it } from 'vitest';
import { resolveDashboardDateRange } from './dashboard-date-range';

describe('resolveDashboardDateRange', () => {
  it('defaults to the last 30 Manila business dates with UTC query boundaries', () => {
    const range = resolveDashboardDateRange(
      {},
      new Date('2026-09-28T15:59:59.999Z'),
    );

    expect(range.from).toBe('2026-08-30');
    expect(range.to).toBe('2026-09-28');
    expect(range.startAt.toISOString()).toBe('2026-08-29T16:00:00.000Z');
    expect(range.endExclusiveAt.toISOString()).toBe('2026-09-28T16:00:00.000Z');
  });

  it.each([7, 30, 90])('accepts a %i-day inclusive date range', (days) => {
    const to = '2026-09-28';
    const fromDate = new Date(`${to}T00:00:00.000Z`);
    fromDate.setUTCDate(fromDate.getUTCDate() - days + 1);
    const from = fromDate.toISOString().slice(0, 10);

    expect(resolveDashboardDateRange({ from, to }).days).toBe(days);
  });

  it.each([
    { from: '2026-09-21', to: '2026-09-28' },
    { from: '2026-09-31', to: '2026-10-07' },
    { from: '2026-09-29', to: '2026-09-28' },
    { from: '2026-09-22' },
  ])('rejects an invalid requested date range %#', (query) => {
    expect(() => resolveDashboardDateRange(query)).toThrow();
  });
});
