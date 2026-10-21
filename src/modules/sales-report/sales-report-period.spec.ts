import { describe, expect, it } from 'vitest';
import {
  percentChange,
  pointChange,
  resolveReportPeriod,
} from './sales-report-period';

// 2026-10-21 15:00 Manila (a Wednesday).
const now = new Date('2026-10-21T07:00:00Z');

describe('resolveReportPeriod', () => {
  it('uses Monday-to-Sunday weeks and ends the current week today', () => {
    expect(resolveReportPeriod({ period: 'week' }, now)).toEqual({
      period: 'week',
      periodRange: { from: '2026-10-19', to: '2026-10-25' },
      range: { from: '2026-10-19', to: '2026-10-21' },
      previousRange: { from: '2026-10-12', to: '2026-10-14' },
      inProgress: true,
    });
    const sunday = resolveReportPeriod(
      { period: 'week', date: '2026-10-18' },
      now,
    );
    expect(sunday.range).toEqual({ from: '2026-10-12', to: '2026-10-18' });
    expect(sunday.previousRange).toEqual({
      from: '2026-10-05',
      to: '2026-10-11',
    });
    expect(sunday.inProgress).toBe(false);
  });

  it('compares a month to date with the same days of the previous month', () => {
    const month = resolveReportPeriod({ period: 'month' }, now);
    expect(month.range).toEqual({ from: '2026-10-01', to: '2026-10-21' });
    expect(month.previousRange).toEqual({
      from: '2026-09-01',
      to: '2026-09-21',
    });
    const march = resolveReportPeriod(
      { period: 'month', date: '2026-03-15' },
      new Date('2026-03-31T07:00:00Z'),
    );
    expect(march.previousRange).toEqual({
      from: '2026-02-01',
      to: '2026-02-28',
    });
  });

  it('compares a day with the day before and rejects future dates', () => {
    const day = resolveReportPeriod({ period: 'day', date: '2026-10-01' }, now);
    expect(day.range).toEqual({ from: '2026-10-01', to: '2026-10-01' });
    expect(day.previousRange).toEqual({ from: '2026-09-30', to: '2026-09-30' });
    expect(() =>
      resolveReportPeriod({ period: 'day', date: '2026-10-22' }, now),
    ).toThrow(/on or before today/);
    expect(() =>
      resolveReportPeriod({ period: 'day', date: '2026-02-30' }, now),
    ).toThrow(/valid calendar date/);
  });

  it('calculates changes', () => {
    expect(percentChange('150', '100')).toBe('50');
    expect(percentChange('80', '120')).toBe('-33.3');
    expect(percentChange('80', '0')).toBeNull();
    expect(pointChange('47.1', '45')).toBe('2.1');
    expect(pointChange(null, '45')).toBeNull();
  });
});
