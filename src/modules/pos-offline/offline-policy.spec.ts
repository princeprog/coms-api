import { describe, expect, it } from 'vitest';
import { offlineTimeProblem } from './offline-policy';

const date = (value: string) => new Date(value);
const window = {
  issuedAt: date('2026-10-25T01:00:00Z'),
  snapshotAt: date('2026-10-25T01:00:01Z'),
  cutoffAt: date('2026-10-25T16:00:00Z'),
  lastCapturedAt: null,
  now: date('2026-10-26T01:00:00Z'),
};
describe('offline occurrence window', () => {
  it('accepts yesterday sales uploaded today without moving their business date', () => {
    expect(
      offlineTimeProblem({ ...window, capturedAt: '2026-10-25T13:00:00Z' }),
    ).toBeNull();
  });
  it.each([
    '2026-10-25T00:59:59Z',
    '2026-10-25T01:00:00Z',
    '2026-10-25T16:00:00Z',
    'invalid',
  ])('holds time outside snapshot and session bounds: %s', (capturedAt) => {
    expect(offlineTimeProblem({ ...window, capturedAt })).not.toBeNull();
  });
  it('holds a backwards device clock even within the selling day', () => {
    expect(
      offlineTimeProblem({
        ...window,
        capturedAt: '2026-10-25T12:59:59Z',
        lastCapturedAt: date('2026-10-25T13:00:00Z'),
      }),
    ).toContain('backwards');
  });
});
