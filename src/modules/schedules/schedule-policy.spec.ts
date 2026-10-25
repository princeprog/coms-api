import { describe, expect, it } from 'vitest';
import {
  crossesDayStart,
  dayWindow,
  isoWeekday,
  shiftLength,
  weekStart,
  windowsOverlap,
} from './schedule-policy';

describe('schedule policy', () => {
  it('measures shifts that pass midnight', () => {
    expect(shiftLength('06:00', '14:00')).toBe(480);
    expect(shiftLength('22:00', '06:00')).toBe(480);
  });

  it('keeps every shift inside one business day', () => {
    expect(crossesDayStart('22:00', '06:00', '00:00')).toBe(true);
    expect(crossesDayStart('22:00', '06:00', '06:00')).toBe(false);
    expect(crossesDayStart('14:00', '22:00', '06:00')).toBe(false);
    // Starting or ending exactly at the day start is fine.
    expect(crossesDayStart('06:00', '14:00', '06:00')).toBe(false);
    expect(crossesDayStart('23:30', '00:00', '00:00')).toBe(false);
    expect(crossesDayStart('04:00', '08:00', '06:00')).toBe(true);
  });

  it('compares shifts from the business day start', () => {
    const night = dayWindow('22:00', '06:00', '06:00');
    const early = dayWindow('02:00', '05:00', '06:00');
    expect(night).toEqual({ from: 960, to: 1440 });
    expect(windowsOverlap(night, early)).toBe(true);
    expect(
      windowsOverlap(
        dayWindow('06:00', '14:00', '06:00'),
        dayWindow('14:00', '22:00', '06:00'),
      ),
    ).toBe(false);
  });

  it('works with ISO weeks', () => {
    expect(weekStart('2026-10-25')).toBe('2026-10-19');
    expect(weekStart('2026-10-19')).toBe('2026-10-19');
    expect(isoWeekday('2026-10-25')).toBe(7);
    expect(isoWeekday('2026-10-26')).toBe(1);
  });
});
