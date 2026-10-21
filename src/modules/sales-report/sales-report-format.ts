import type { SalesReport } from './sales-report.service';

/** ₱1,234.50 from an exact decimal string; negatives as −₱. */
export function peso(value: string | null | undefined) {
  if (value === null || value === undefined) return '—';
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const amount = `₱${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${fraction.padEnd(2, '0').slice(0, 2)}`;
  return negative ? `−${amount}` : amount;
}

export function count(value: string | number) {
  const [whole, fraction] = String(value).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction ? `${grouped}.${fraction}` : grouped;
}

export function percent(value: string | null) {
  return value === null ? '—' : `${value}%`;
}

export function change(value: string | null, unit: '%' | ' pts' = '%') {
  if (value === null) return '';
  const number = Number(value);
  if (number === 0) return `0${unit}`;
  return `${number > 0 ? '+' : '−'}${String(Math.abs(number))}${unit}`;
}

export function serviceLabel(value: string) {
  return value === 'DINE_IN'
    ? 'Dine-in'
    : value === 'TAKEAWAY'
      ? 'Takeout'
      : value;
}

function day(value: string, options: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat('en-PH', {
    timeZone: 'UTC',
    ...options,
  }).format(new Date(`${value}T00:00:00.000Z`));
}

export function shortDate(value: string) {
  return day(value, { month: 'short', day: 'numeric' });
}

export function longDate(value: string) {
  return day(value, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function periodLabel(
  report: Pick<
    SalesReport,
    'period' | 'period_range' | 'range' | 'in_progress'
  >,
) {
  const { period, period_range: full, range } = report;
  if (period === 'day')
    return day(range.from, {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    });
  if (period === 'month') {
    const label = day(full.from, { month: 'long', year: 'numeric' });
    return report.in_progress ? `${label} (to ${shortDate(range.to)})` : label;
  }
  const label = `Week of ${shortDate(full.from)} – ${longDate(full.to)}`;
  return report.in_progress ? `${label} (to ${shortDate(range.to)})` : label;
}

export function comparisonLabel(
  report: Pick<SalesReport, 'period' | 'in_progress'>,
) {
  if (report.period === 'day') return 'vs previous day';
  const unit = report.period === 'week' ? 'week' : 'month';
  return report.in_progress
    ? `vs same point last ${unit}`
    : `vs previous ${unit}`;
}

export function manilaDateTime(value: Date) {
  return new Intl.DateTimeFormat('en-PH', {
    timeZone: 'Asia/Manila',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(value);
}
