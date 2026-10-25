/** Minutes after midnight for "HH:MM" or "HH:MM:SS". */
export function toMinutes(time: string) {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

/** Length of a shift in minutes; an end before the start means it passes midnight. */
export function shiftLength(start: string, end: string) {
  return (toMinutes(end) - toMinutes(start) + 1440) % 1440;
}

/**
 * True when the business day's start falls strictly inside the shift. A shift
 * may start or end exactly at the day start, so every shift stays inside one
 * business day.
 */
export function crossesDayStart(start: string, end: string, dayStart: string) {
  const offset = (toMinutes(dayStart) - toMinutes(start) + 1440) % 1440;
  return offset > 0 && offset < shiftLength(start, end);
}

/** The shift as minutes from the business day's start. */
export function dayWindow(start: string, end: string, dayStart: string) {
  const from = (toMinutes(start) - toMinutes(dayStart) + 1440) % 1440;
  return { from, to: from + shiftLength(start, end) };
}

export function windowsOverlap(
  a: { from: number; to: number },
  b: { from: number; to: number },
) {
  return a.from < b.to && b.from < a.to;
}

const weekdayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** ISO weekday (1 = Monday) to a short name. */
export function weekdayName(weekday: number) {
  return weekdayNames[weekday - 1] ?? String(weekday);
}

/** "06:00–14:00" */
export function timeRange(start: string, end: string) {
  return `${start.slice(0, 5)}–${end.slice(0, 5)}`;
}

/** Monday of the ISO week containing a YYYY-MM-DD date. */
export function weekStart(date: string) {
  const day = new Date(`${date}T00:00:00.000Z`);
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return day.toISOString().slice(0, 10);
}

export function addDays(date: string, days: number) {
  const day = new Date(`${date}T00:00:00.000Z`);
  day.setUTCDate(day.getUTCDate() + days);
  return day.toISOString().slice(0, 10);
}

/** ISO weekday (1 = Monday … 7 = Sunday) of a YYYY-MM-DD date. */
export function isoWeekday(date: string) {
  return ((new Date(`${date}T00:00:00.000Z`).getUTCDay() + 6) % 7) + 1;
}

export function isCalendarDate(value: string) {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}
