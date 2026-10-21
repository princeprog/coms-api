import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { normalizeLevel, parseLevels } from './stock-levels.policy';

describe('stock levels', () => {
  it('normalizes decimal levels', () => {
    expect(normalizeLevel('04.500')).toBe('4.5');
    expect(normalizeLevel('0.000')).toBe('0');
    expect(normalizeLevel('12')).toBe('12');
  });

  it('accepts a target above the reorder level and clears with two nulls', () => {
    expect(parseLevels('0', '0.001')).toEqual({
      reorderLevel: '0',
      targetLevel: '0.001',
    });
    expect(parseLevels(' 5.50 ', '20')).toEqual({
      reorderLevel: '5.5',
      targetLevel: '20',
    });
    expect(parseLevels(null, null)).toBeNull();
  });

  it.each([
    ['5', null],
    ['5', '5'],
    ['6', '5'],
    ['-1', '5'],
    ['1.2345', '5'],
    ['1e3', '5000'],
    ['1234567890', '9999999999'],
  ])('rejects reorder %s with target %s', (reorder, target) => {
    expect(() => parseLevels(reorder, target)).toThrow(BadRequestException);
  });
});
