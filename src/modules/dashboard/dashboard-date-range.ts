import { BadRequestException } from '@nestjs/common';

export const DASHBOARD_TIME_ZONE = 'Asia/Manila';
const DAY_MS = 24 * 60 * 60 * 1000;
const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;
const ALLOWED_RANGE_DAYS = new Set([7, 30, 90]);

export type DashboardDateQuery = { from?: string; to?: string };

export type DashboardDateRange = {
  from: string;
  to: string;
  days: number;
  startAt: Date;
  endExclusiveAt: Date;
};

export function resolveDashboardDateRange(
  query: DashboardDateQuery,
  now = new Date(),
): DashboardDateRange {
  let from = query.from;
  let to = query.to;

  if (from === undefined && to === undefined) {
    to = getManilaDate(now);
    const end = parseDate(to);
    from = formatDate(end - 29 * DAY_MS);
  } else if (from === undefined || to === undefined) {
    throw new BadRequestException('Both from and to dates are required');
  }

  const fromTime = parseDate(from);
  const toTime = parseDate(to);
  if (fromTime > toTime)
    throw new BadRequestException('The start date must be before the end date');

  const days = Math.floor((toTime - fromTime) / DAY_MS) + 1;
  if (!ALLOWED_RANGE_DAYS.has(days))
    throw new BadRequestException('Choose a 7, 30, or 90-day date range');

  return {
    from,
    to,
    days,
    startAt: new Date(fromTime - MANILA_OFFSET_MS),
    endExclusiveAt: new Date(toTime + DAY_MS - MANILA_OFFSET_MS),
  };
}

function getManilaDate(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: DASHBOARD_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: string) =>
    parts.find((entry) => entry.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function parseDate(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new BadRequestException('Dates must use YYYY-MM-DD format');
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value)
    throw new BadRequestException('Enter a valid calendar date');
  return date.getTime();
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}
