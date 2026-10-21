import { BadRequestException } from '@nestjs/common';

export type ReportPeriod = 'day' | 'week' | 'month';
export type DateRange = { from: string; to: string };
export type ResolvedPeriod = {
  period: ReportPeriod;
  /** Full calendar period the date falls in. */
  periodRange: DateRange;
  /** Reported dates: the period, ending today while it is in progress. */
  range: DateRange;
  /** Same number of elapsed days at the start of the previous period. */
  previousRange: DateRange;
  inProgress: boolean;
};

const DAY_MS = 86_400_000;

export function manilaToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function time(value: string) {
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed) ||
    new Date(parsed).toISOString().slice(0, 10) !== value
  )
    throw new BadRequestException('Enter a valid calendar date');
  return parsed;
}

export function addDays(value: string, days: number) {
  return new Date(time(value) + days * DAY_MS).toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string) {
  return Math.round((time(to) - time(from)) / DAY_MS) + 1;
}

function monthEnd(start: string) {
  const [year, month] = start.split('-').map(Number);
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

function bounds(period: ReportPeriod, date: string): DateRange {
  if (period === 'day') return { from: date, to: date };
  if (period === 'week') {
    // Weeks run Monday to Sunday.
    const weekday = (new Date(time(date)).getUTCDay() + 6) % 7;
    const from = addDays(date, -weekday);
    return { from, to: addDays(from, 6) };
  }
  const from = `${date.slice(0, 8)}01`;
  return { from, to: monthEnd(from) };
}

export function resolveReportPeriod(
  input: { period?: ReportPeriod; date?: string },
  now = new Date(),
): ResolvedPeriod {
  const period = input.period ?? 'week';
  const today = manilaToday(now);
  const date = input.date ?? today;
  time(date);
  if (date > today)
    throw new BadRequestException('Choose a date on or before today');
  const periodRange = bounds(period, date);
  const to = periodRange.to < today ? periodRange.to : today;
  const elapsed = daysBetween(periodRange.from, to);
  const previousPeriod = bounds(period, addDays(periodRange.from, -1));
  const previousTo = addDays(previousPeriod.from, elapsed - 1);
  return {
    period,
    periodRange,
    range: { from: periodRange.from, to },
    previousRange: {
      from: previousPeriod.from,
      to: previousTo < previousPeriod.to ? previousTo : previousPeriod.to,
    },
    inProgress: periodRange.to >= today,
  };
}

/** Percent change, or null when there is nothing to compare against. */
export function percentChange(current: string, previous: string) {
  const before = Number(previous);
  if (!before) return null;
  return String(Math.round(((Number(current) - before) / before) * 1000) / 10);
}

/** Difference in percentage points between two percentages. */
export function pointChange(current: string | null, previous: string | null) {
  if (current === null || previous === null) return null;
  return String(Math.round((Number(current) - Number(previous)) * 10) / 10);
}
