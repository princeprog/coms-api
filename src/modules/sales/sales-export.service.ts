import { Injectable } from '@nestjs/common';
import { csvLabel } from '../../common/utils/csv';
import { CsvExportService, exportPage } from '../exports/csv-export.service';
import type { SaleQueryDto } from './dto/sale-query.dto';
import { SalesService } from './sales.service';

@Injectable()
export class SalesExportService {
  constructor(
    private readonly sales: SalesService,
    private readonly csv: CsvExportService,
  ) {}

  async history(branchId: string, query: SaleQueryDto) {
    const result = await this.sales.list(branchId, { ...query, ...exportPage });
    return this.csv.file({
      label: 'Sales history',
      nameParts: [
        'sales',
        await this.csv.branchCode(branchId),
        this.csv.range(query.date_from, query.date_to),
      ],
      branchId,
      filters: query,
      total: result.total,
      rows: result.items,
      columns: [
        { header: 'Sale', value: (sale) => sale.sale_reference },
        { header: 'Date and time', value: (sale) => sale.created_at },
        { header: 'Cashier', value: (sale) => sale.cashier_name },
        {
          header: 'Service type',
          value: (sale) => csvLabel(sale.service_type),
        },
        { header: 'Payment', value: (sale) => sale.tender_method },
        { header: 'Status', value: (sale) => csvLabel(sale.status) },
        { header: 'Total', value: (sale) => sale.total_amount },
      ],
    });
  }
}
