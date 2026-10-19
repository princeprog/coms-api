import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { DispatchQueryDto } from './dispatch-query.dto';

describe('dispatch pagination query', () => {
  it('defaults to 10 records on the first page', async () => {
    const query = plainToInstance(DispatchQueryDto, {});
    expect(query.page).toBe(1);
    expect(query.page_size).toBe(10);
    expect(await validate(query)).toEqual([]);
  });

  it.each([10, 20, 30, 50])(
    'accepts page size %i with filters',
    async (size) => {
      const query = plainToInstance(DispatchQueryDto, {
        page: '2',
        page_size: String(size),
        search: ' Main ',
        status: 'DRAFT',
        sort: 'oldest',
      });
      expect(query.page_size).toBe(size);
      expect(query.search).toBe('Main');
      expect(await validate(query)).toEqual([]);
    },
  );

  it.each(['0', '-1', '101', '10.5', 'invalid'])(
    'rejects invalid page size %s',
    async (size) => {
      expect(
        (await validate(plainToInstance(DispatchQueryDto, { page_size: size })))
          .length,
      ).toBeGreaterThan(0);
    },
  );
});
