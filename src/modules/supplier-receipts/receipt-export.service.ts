import { Injectable } from '@nestjs/common';
import { CsvExportService, exportPage } from '../exports/csv-export.service';
import { DirectPurchasesService } from './direct-purchases.service';
import type { DirectPurchaseQueryDto } from './dto/direct-purchase.dto';
import type { SupplierReceiptQueryDto } from './dto/supplier-receipt-query.dto';
import { ReceiptExportRepository } from './receipt-export.repository';
import { SupplierReceiptsService } from './supplier-receipts.service';

@Injectable()
export class ReceiptExportService {
  constructor(
    private readonly deliveries: SupplierReceiptsService,
    private readonly purchases: DirectPurchasesService,
    private readonly repository: ReceiptExportRepository,
    private readonly csv: CsvExportService,
  ) {}

  async supplierDeliveries(query: SupplierReceiptQueryDto) {
    const receipts = await this.deliveries.list({ ...query, ...exportPage });
    this.csv.assertWithinLimit(receipts.total);
    const rows = await this.repository.lines(receipts.items.map((r) => r.id));
    return this.csv.file({
      label: 'Supplier deliveries',
      nameParts: [
        'supplier-deliveries',
        this.csv.range(query.received_from, query.received_to),
      ],
      filters: query,
      total: rows.length,
      rows,
      columns: [
        { header: 'Received on', value: (row) => row.received_on },
        { header: 'Supplier', value: (row) => row.supplier_name },
        { header: 'Stock item', value: (row) => row.stock_item_name },
        { header: 'Unit', value: (row) => row.unit },
        { header: 'Quantity', value: (row) => row.quantity },
        { header: 'Unit cost', value: (row) => row.unit_cost },
        { header: 'Line total', value: (row) => row.line_total },
        { header: 'Recorded by', value: (row) => row.recorded_by },
        { header: 'Recorded at', value: (row) => row.recorded_at },
      ],
    });
  }

  async directPurchases(query: DirectPurchaseQueryDto) {
    const receipts = await this.purchases.list({ ...query, ...exportPage });
    this.csv.assertWithinLimit(receipts.total);
    const rows = await this.repository.lines(receipts.items.map((r) => r.id));
    return this.csv.file({
      label: 'Direct purchases',
      nameParts: [
        'direct-purchases',
        this.csv.range(query.purchased_from, query.purchased_to),
      ],
      filters: query,
      total: rows.length,
      rows,
      columns: [
        { header: 'Purchased on', value: (row) => row.received_on },
        { header: 'Store', value: (row) => row.store_name },
        { header: 'Receipt number', value: (row) => row.receipt_number },
        { header: 'Stock item', value: (row) => row.stock_item_name },
        { header: 'Unit', value: (row) => row.unit },
        { header: 'Quantity', value: (row) => row.quantity },
        { header: 'Unit cost', value: (row) => row.unit_cost },
        { header: 'Line total', value: (row) => row.line_total },
        { header: 'Recorded by', value: (row) => row.recorded_by },
      ],
    });
  }
}
