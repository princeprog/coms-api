import { describe, expect, it } from 'vitest';
import { deliveryBusinessDate, receivingDeadline } from './receiving-policy';

describe('receiving time policy', () => {
  const now = new Date('2026-10-20T17:00:00Z');
  it('uses a 24-hour deadline and rejects past dates', () => {
    expect(receivingDeadline(undefined, now).toISOString()).toBe(
      '2026-10-21T17:00:00.000Z',
    );
    expect(() => receivingDeadline(now.toISOString(), now)).toThrow('future');
  });
  it('uses Philippine dates and requires a reason for prior-day or overdue counts', () => {
    const sent = new Date('2026-10-19T12:00:00Z');
    expect(deliveryBusinessDate(undefined, sent, now)).toBe('2026-10-21');
    expect(() => deliveryBusinessDate('2026-10-20', sent, now)).toThrow('late');
    expect(
      deliveryBusinessDate('2026-10-20', sent, now, 'Forgot to submit'),
    ).toBe('2026-10-20');
    expect(() =>
      deliveryBusinessDate(undefined, sent, now, null, sent),
    ).toThrow('late');
    for (const invalid of ['2026-10-18', '2026-10-22', '2026-02-30'])
      expect(() => deliveryBusinessDate(invalid, sent, now, 'Reason')).toThrow(
        'Delivery date',
      );
  });
});
