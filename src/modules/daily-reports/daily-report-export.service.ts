import { Injectable } from '@nestjs/common';
import { csvLabel } from '../../common/utils/csv';
import { CsvExportService, exportPage } from '../exports/csv-export.service';
import { DailyReportExportRepository } from './daily-report-export.repository';
import { DailyReportsService } from './daily-reports.service';
import type { DailyReportQueryDto } from './dto/daily-report-query.dto';

@Injectable()
export class DailyReportExportService {
  constructor(
    private readonly reports: DailyReportsService,
    private readonly repository: DailyReportExportRepository,
    private readonly csv: CsvExportService,
  ) {}

  async items(branchId: string, query: DailyReportQueryDto) {
    const reports = await this.reports.list(branchId, {
      ...query,
      ...exportPage,
    });
    this.csv.assertWithinLimit(reports.total);
    const rows = await this.repository.items(reports.items.map((r) => r.id));
    return this.csv.file({
      label: 'Daily report items',
      nameParts: [
        'daily-reports',
        await this.csv.branchCode(branchId),
        query.status?.toLowerCase() ?? 'all',
      ],
      branchId,
      filters: query,
      total: rows.length,
      rows,
      columns: [
        { header: 'Business day', value: (row) => row.business_date },
        { header: 'Report status', value: (row) => csvLabel(row.status) },
        { header: 'Stock item', value: (row) => row.stock_item_name },
        { header: 'Unit', value: (row) => row.unit },
        { header: 'Opening', value: (row) => row.opening },
        { header: 'Received', value: (row) => row.received },
        { header: 'Used by sales', value: (row) => row.used_by_sales },
        { header: 'Returned by voids', value: (row) => row.void_returns },
        { header: 'Waste', value: (row) => row.waste },
        { header: 'Waste reason', value: (row) => row.waste_reason },
        { header: 'Adjustment', value: (row) => row.adjustment },
        { header: 'Adjustment reason', value: (row) => row.adjustment_reason },
        { header: 'Expected closing', value: (row) => row.expected_closing },
        { header: 'Counted closing', value: (row) => row.counted_closing },
        { header: 'Variance', value: (row) => row.variance },
        { header: 'Unit cost', value: (row) => row.unit_cost },
        { header: 'Variance value', value: (row) => row.variance_value },
      ],
    });
  }
}
