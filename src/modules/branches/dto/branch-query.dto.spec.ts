import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { BranchQueryDto } from './branch-query.dto';

describe('branch directory query validation', () => {
  it.each([
    { status: 'deleted' },
    { service_type: 'DELIVERY' },
    { sort_by: 'price' },
    { sort_order: 'sideways' },
  ])('rejects unsupported filters and sorting: %j', async (input) => {
    const errors = await validate(plainToInstance(BranchQueryDto, input));
    expect(errors.length).toBeGreaterThan(0);
  });
  it('accepts combined supported filters', async () => {
    const errors = await validate(
      plainToInstance(BranchQueryDto, {
        search: ' Main ',
        status: 'active',
        service_type: 'TAKEAWAY',
        sort_by: 'date_opened',
        sort_order: 'desc',
        page: '2',
        page_size: '8',
      }),
    );
    expect(errors).toEqual([]);
  });
});
