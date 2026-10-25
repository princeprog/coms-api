import { Injectable } from '@nestjs/common';
import { csvLabel } from '../../common/utils/csv';
import { CsvExportService, exportPage } from '../exports/csv-export.service';
import type { InventoryMovementQueryDto } from './dto/inventory-movement-query.dto';
import type { InventoryQueryDto } from './dto/inventory-query.dto';
import { InventoryService } from './inventory.service';

type Balance = {
  stock_item_name: string;
  category: string;
  unit: string;
  is_active: boolean;
  quantity_on_hand: string;
  reorder_level: string | null;
  target_level: string | null;
  stock_status: string;
};
type Movement = {
  occurred_at: Date;
  stock_item_name: string;
  unit: string;
  movement_type: string;
  quantity_delta: string;
  reason: string | null;
  receipt_kind: string | null;
  actor_user_id: string | null;
};

@Injectable()
export class InventoryExportService {
  constructor(
    private readonly inventory: InventoryService,
    private readonly csv: CsvExportService,
  ) {}

  async commissaryBalances(query: InventoryQueryDto) {
    const result = await this.inventory.listCommissary({
      ...query,
      ...exportPage,
    });
    return this.balances('Commissary inventory', 'commissary', query, result);
  }

  async branchBalances(branchId: string, query: InventoryQueryDto) {
    const result = await this.inventory.listBranch(branchId, {
      ...query,
      ...exportPage,
    });
    return this.balances(
      'Branch inventory',
      await this.csv.branchCode(branchId),
      query,
      result,
      branchId,
    );
  }

  async commissaryMovements(query: InventoryMovementQueryDto) {
    const result = await this.inventory.listCommissaryMovements({
      ...query,
      ...exportPage,
    });
    return this.movements('Commissary movements', 'commissary', query, result);
  }

  async branchMovements(branchId: string, query: InventoryMovementQueryDto) {
    const result = await this.inventory.listBranchMovements(branchId, {
      ...query,
      ...exportPage,
    });
    return this.movements(
      'Branch movements',
      await this.csv.branchCode(branchId),
      query,
      result,
      branchId,
    );
  }

  private balances(
    label: string,
    place: string,
    query: object,
    result: { items: Balance[]; total: number },
    branchId?: string,
  ) {
    return this.csv.file({
      label,
      nameParts: ['inventory', place],
      branchId,
      filters: query,
      total: result.total,
      rows: result.items,
      columns: [
        { header: 'Stock item', value: (row) => row.stock_item_name },
        { header: 'Category', value: (row) => row.category },
        { header: 'Unit', value: (row) => row.unit },
        { header: 'On hand', value: (row) => row.quantity_on_hand },
        { header: 'Reorder level', value: (row) => row.reorder_level },
        { header: 'Target level', value: (row) => row.target_level },
        { header: 'Status', value: (row) => csvLabel(row.stock_status) },
        { header: 'Active', value: (row) => row.is_active },
      ],
    });
  }

  private async movements(
    label: string,
    place: string,
    query: object,
    result: { items: Movement[]; total: number },
    branchId?: string,
  ) {
    this.csv.assertWithinLimit(result.total);
    const names = await this.csv.userNames(
      result.items.map((row) => row.actor_user_id),
    );
    return this.csv.file({
      label,
      nameParts: ['inventory-movements', place],
      branchId,
      filters: query,
      total: result.total,
      rows: result.items,
      columns: [
        { header: 'Date and time', value: (row) => row.occurred_at },
        { header: 'Stock item', value: (row) => row.stock_item_name },
        { header: 'Unit', value: (row) => row.unit },
        { header: 'Movement', value: (row) => csvLabel(row.movement_type) },
        { header: 'Quantity change', value: (row) => row.quantity_delta },
        {
          header: 'Source',
          value: (row) => row.reason ?? csvLabel(row.receipt_kind),
        },
        {
          header: 'Recorded by',
          value: (row) =>
            row.actor_user_id ? names.get(row.actor_user_id) : 'System',
        },
      ],
    });
  }
}
