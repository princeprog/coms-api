import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { BranchQueryDto } from '../../modules/branches/dto/branch-query.dto';
import { ProductQueryDto } from '../../modules/products/dto/product-query.dto';
import { StaffQueryDto } from '../../modules/staff/dto/staff-query.dto';
import { containsSearchPattern } from './list-filters';
import { paginatedResult, paginationOffset } from './pagination';

describe('shared list query rules', () => {
  it.each([10, 20, 50, 100])('accepts a requested page size of %i', (size) => {
    const query = plainToInstance(BranchQueryDto, {
      page: '3',
      page_size: String(size),
    });

    expect(validateSync(query)).toEqual([]);
    expect(paginationOffset(query)).toBe(size * 2);
    expect(paginatedResult(['record'], 121, query)).toEqual({
      items: ['record'],
      total: 121,
      page: 3,
      page_size: size,
    });
  });

  it.each(['0', '101', '1.5', 'abc'])(
    'rejects invalid page size %s',
    (size) => {
      const query = plainToInstance(StaffQueryDto, { page_size: size });
      expect(
        validateSync(query).some((error) => error.property === 'page_size'),
      ).toBe(true);
    },
  );

  it('preserves defaults and validates resource filters alongside pagination', () => {
    const query = plainToInstance(ProductQueryDto, {
      page_size: '20',
      search: '  chicken  ',
      is_active: 'false',
    });

    expect(validateSync(query)).toEqual([]);
    expect(query).toMatchObject({
      page: 1,
      page_size: 20,
      search: 'chicken',
      is_active: false,
    });
  });

  it('treats SQL wildcard characters in a search as literal text', () => {
    expect(containsSearchPattern('  50%_\\  ')).toBe(String.raw`%50\%\_\\%`);
  });
});
