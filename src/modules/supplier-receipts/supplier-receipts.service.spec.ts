import { BadRequestException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { SupplierReceiptsService } from './supplier-receipts.service';

vi.mock('../../database/database.module', () => ({
  DATABASE: Symbol('DATABASE'),
}));

describe('SupplierReceiptsService', () => {
  it('normalizes decimal strings and the idempotency key before creation', async () => {
    const repository = {
      create: vi.fn().mockResolvedValue({ id: 'receipt-1' }),
    };
    const service = new SupplierReceiptsService(repository as never);
    const supplierId = randomUUID();
    const stockItemId = randomUUID();
    const actorId = randomUUID();
    const idempotencyKey = randomUUID();

    await expect(
      service.create(
        {
          supplier_id: supplierId,
          received_at: '2026-09-24',
          items: [
            {
              stock_item_id: stockItemId,
              quantity_received: '0002.5000',
              unit_cost: '089.250',
            },
          ],
        } as never,
        actorId,
        ` ${idempotencyKey} `,
      ),
    ).resolves.toEqual({ id: 'receipt-1' });

    expect(repository.create).toHaveBeenCalledWith({
      supplier_id: supplierId,
      received_at: '2026-09-24',
      items: [
        {
          stock_item_id: stockItemId,
          quantity_received: '2.5',
          unit_cost: '89.25',
        },
      ],
      created_by_user_id: actorId,
      idempotency_key: idempotencyKey,
    });
  });

  it.each([
    { items: [] },
    { items: [{ quantity_received: '0', unit_cost: '1' }] },
    { items: [{ quantity_received: '1e2', unit_cost: '1' }] },
    { items: [{ quantity_received: '1', unit_cost: '-0.01' }] },
  ])(
    'rejects invalid receipt quantities, costs, and empty receipts',
    async (patch) => {
      const repository = { create: vi.fn() };
      const service = new SupplierReceiptsService(repository as never);
      const input = Object.assign(
        {
          supplier_id: randomUUID(),
          received_at: '2026-09-24',
          items: [
            {
              stock_item_id: randomUUID(),
              quantity_received: '1',
              unit_cost: '1',
            },
          ],
        },
        patch,
      );

      await expect(
        service.create(input as never, randomUUID(), randomUUID()),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repository.create).not.toHaveBeenCalled();
    },
  );

  it('requires a UUID idempotency key', async () => {
    const repository = { create: vi.fn() };
    const service = new SupplierReceiptsService(repository as never);
    const input = {
      supplier_id: randomUUID(),
      received_at: '2026-09-24',
      items: [
        {
          stock_item_id: randomUUID(),
          quantity_received: '1',
          unit_cost: '1',
        },
      ],
    };

    await expect(
      service.create(input as never, randomUUID(), undefined),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.create(input as never, randomUUID(), 'not-a-uuid'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repository.create).not.toHaveBeenCalled();
  });

  it.each(['2026-02-30', '2026-09-24T12:30:00Z', '0000-01-01'])(
    'rejects invalid date-only received date %s',
    async (receivedAt) => {
      const repository = { create: vi.fn() };
      const service = new SupplierReceiptsService(repository as never);
      const input = {
        supplier_id: randomUUID(),
        received_at: receivedAt,
        items: [
          {
            stock_item_id: randomUUID(),
            quantity_received: '1',
            unit_cost: '1',
          },
        ],
      };

      await expect(
        service.create(input as never, randomUUID(), randomUUID()),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repository.create).not.toHaveBeenCalled();
    },
  );

  it('trims and omits a blank list search and delegates posting with the actor', async () => {
    const repository = {
      list: vi.fn().mockResolvedValue({ items: [], total: 0 }),
      findById: vi.fn().mockResolvedValue({ id: 'receipt-1' }),
      post: vi.fn().mockResolvedValue({ id: 'receipt-1', status: 'POSTED' }),
    };
    const service = new SupplierReceiptsService(repository as never);
    const query = { page: 2, page_size: 10, search: '   ' } as never;

    await expect(service.list(query)).resolves.toEqual({ items: [], total: 0 });
    await expect(service.get('receipt-1')).resolves.toEqual({
      id: 'receipt-1',
    });
    await expect(service.post('receipt-1', 'actor-1')).resolves.toMatchObject({
      status: 'POSTED',
    });

    expect(repository.list).toHaveBeenCalledWith({ page: 2, page_size: 10 });
    expect(repository.post).toHaveBeenCalledWith('receipt-1', 'actor-1');
  });

  it('reports a missing receipt as not found', async () => {
    const repository = { findById: vi.fn().mockResolvedValue(undefined) };
    const service = new SupplierReceiptsService(repository as never);

    await expect(service.get(randomUUID())).rejects.toMatchObject({
      status: 404,
      message: 'Supplier receipt not found',
    });
  });
});
