import 'reflect-metadata';
import { PaginationQueryDto } from './pagination-query.dto';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { InventoryQueryDto } from '../../modules/inventory/dto/inventory-query.dto';
import { StockItemQueryDto } from '../../modules/stock-items/dto/stock-item-query.dto';
import { ProductQueryDto } from '../../modules/products/dto/product-query.dto';
import { BranchProductQueryDto } from '../../modules/branch-products/dto/branch-product-query.dto';

describe.each([
  InventoryQueryDto,
  StockItemQueryDto,
  ProductQueryDto,
  BranchProductQueryDto,
])('%s pagination', (Dto) => {
  it('defaults to ten rows', async () => {
    const query = plainToInstance<PaginationQueryDto, object>(Dto, {});
    expect(query.page_size).toBe(10);
    expect(await validate(query)).toEqual([]);
  });
  it.each([10, 30, 50, 25])(
    'accepts size %s, including existing lookup callers',
    async (size) => {
      const query = plainToInstance<PaginationQueryDto, object>(Dto, {
        page: '2',
        page_size: String(size),
      });
      expect(await validate(query)).toEqual([]);
      expect(query.page_size).toBe(size);
      expect(query.page).toBe(2);
    },
  );
  it.each(['0', '-1', '101', '2.5', 'invalid'])(
    'rejects invalid size %s',
    async (size) => {
      expect(
        (
          await validate(
            plainToInstance<PaginationQueryDto, object>(Dto, {
              page_size: size,
            }),
          )
        ).some((error) => error.property === 'page_size'),
      ).toBe(true);
    },
  );
});
