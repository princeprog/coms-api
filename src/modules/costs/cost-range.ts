import { BadRequestException } from '@nestjs/common';

const DAY_MS = 86_400_000;
const MAX_DAYS = 366;

export type CostRange = { from: string; to: string };

function manilaToday(now: Date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function parse(value: string) {
  const time = Date.parse(`${value}T00:00:00.000Z`);
  if (Number.isNaN(time) || new Date(time).toISOString().slice(0, 10) !== value)
    throw new BadRequestException('Enter a valid calendar date');
  return time;
}

// Business dates; defaults to the last 7 days ending today in Manila.
export function resolveCostRange(
  query: { from?: string; to?: string },
  now = new Date(),
): CostRange {
  if ((query.from === undefined) !== (query.to === undefined))
    throw new BadRequestException('Both from and to dates are required');
  const to = query.to ?? manilaToday(now);
  const from =
    query.from ?? new Date(parse(to) - 6 * DAY_MS).toISOString().slice(0, 10);
  const days = (parse(to) - parse(from)) / DAY_MS + 1;
  if (days < 1)
    throw new BadRequestException('The start date must be before the end date');
  if (days > MAX_DAYS)
    throw new BadRequestException('Choose a range of at most 366 days');
  return { from, to };
}
