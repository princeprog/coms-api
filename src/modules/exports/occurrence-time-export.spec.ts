import { describe, expect, it, vi } from 'vitest';
import { toCsv } from '../../common/utils/csv';
import { InventoryExportService } from '../inventory/inventory-export.service';
import type { InventoryService } from '../inventory/inventory.service';
import { SalesExportService } from '../sales/sales-export.service';
import type { SalesService } from '../sales/sales.service';
import type { CsvExport, CsvExportService } from './csv-export.service';

vi.mock('../../database/database.module', () => ({
  DATABASE: Symbol('DATABASE'),
}));

describe('occurrence time in customer exports', () => {
  const occurredAt = new Date('2026-09-23T15:59:00Z');
  const createdAt = new Date('2026-09-25T04:30:00Z');
  const csv = {
    branchCode: async () => 'BRANCH',
    range: () => 'range',
    assertWithinLimit: () => {},
    userNames: async () => new Map(),
    file: async <T>(input: CsvExport<T>) => toCsv(input.columns, input.rows),
  } as unknown as CsvExportService;

  it('exports the cashier sale time while preserving the posting timestamp', async () => {
    const row = {
      sale_reference: 'S-1',
      occurred_at: occurredAt,
      created_at: createdAt,
    };
    const sales = {
      list: vi.fn().mockResolvedValue({ items: [row], total: 1 }),
    };
    const result = await new SalesExportService(
      sales as unknown as SalesService,
      csv,
    ).history('branch', {
      page: 1,
      page_size: 10,
      date_from: '2026-09-23',
      date_to: '2026-09-23',
    });
    expect(result).toContain('2026-09-23 23:59');
    expect(result).not.toContain('2026-09-25 12:30');
    expect(row.created_at).toBe(createdAt);
    expect(sales.list).toHaveBeenCalledWith(
      'branch',
      expect.objectContaining({
        date_from: '2026-09-23',
        date_to: '2026-09-23',
      }),
    );
  });

  it('exports movement occurrence time', async () => {
    const inventory = {
      listBranchMovements: async () => ({
        items: [{ occurred_at: occurredAt, created_at: createdAt }],
        total: 1,
      }),
    } as unknown as InventoryService;
    const result = await new InventoryExportService(
      inventory,
      csv,
    ).branchMovements('branch', { page: 1, page_size: 10 });
    expect(result).toContain('2026-09-23 23:59');
    expect(result).not.toContain('2026-09-25 12:30');
  });
});
