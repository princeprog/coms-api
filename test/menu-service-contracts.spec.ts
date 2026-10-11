import 'reflect-metadata';
import '../src/config/load-env';
import { describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateSaleDto } from '../src/modules/sales/dto/create-sale.dto';
import { CreateBranchProductDto } from '../src/modules/branch-products/dto/create-branch-product.dto';

const id = '00000000-0000-4000-8000-000000000001';
describe('menu service contracts', () => {
  it('requires service type for a new sale', async () => {
    const errors = await validate(
      plainToInstance(CreateSaleDto, {
        tender_method: 'cash',
        items: [{ product_id: id, quantity: '1', price_revision: 1 }],
      }),
    );
    expect(errors.some((error) => error.property === 'service_type')).toBe(
      true,
    );
  });
  it('requires a price revision on every sale line', async () => {
    const errors = await validate(
      plainToInstance(CreateSaleDto, {
        service_type: 'TAKEAWAY',
        tender_method: 'cash',
        items: [{ product_id: id, quantity: '1' }],
      }),
    );
    expect(errors.some((error) => error.property === 'items')).toBe(true);
  });
  it('rejects client-entered menu prices', async () => {
    const errors = await validate(
      plainToInstance(CreateBranchProductDto, {
        product_id: id,
        service_types: ['TAKEAWAY'],
        price: '0.01',
      }),
      { whitelist: true, forbidNonWhitelisted: true },
    );
    expect(errors.some((error) => error.property === 'price')).toBe(true);
  });
});
