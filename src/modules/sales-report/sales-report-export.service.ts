import { Injectable } from '@nestjs/common';
import type { AccessContext } from '../access-control/access-control.types';
import { CsvExportService } from '../exports/csv-export.service';
import type { SalesReportQueryDto } from './dto/sales-report-query.dto';
import { serviceLabel } from './sales-report-format';
import { renderSalesReportPdf } from './sales-report-pdf';
import { SalesReportService, type SalesReport } from './sales-report.service';

type CsvRow = {
  section: string;
  item: string;
  metric: string;
  value: string | number | null;
  previous?: string | number | null;
  change?: string | null;
};

@Injectable()
export class SalesReportExportService {
  constructor(
    private readonly reports: SalesReportService,
    private readonly files: CsvExportService,
  ) {}

  async csv(query: SalesReportQueryDto, access: AccessContext) {
    const report = await this.reports.report(query, access);
    const rows = this.rows(report);
    return this.files.file({
      label: 'Sales report',
      nameParts: this.nameParts(report),
      branchId: report.branch?.id,
      filters: { ...query, period: report.period },
      total: rows.length,
      rows,
      columns: [
        { header: 'Section', value: (row) => row.section },
        { header: 'Item', value: (row) => row.item },
        { header: 'Metric', value: (row) => row.metric },
        { header: 'Value', value: (row) => row.value },
        { header: 'Previous period', value: (row) => row.previous },
        { header: 'Change', value: (row) => row.change },
      ],
    });
  }

  async pdf(query: SalesReportQueryDto, access: AccessContext) {
    const [report, generatedBy] = await Promise.all([
      this.reports.report(query, access),
      this.reports.generatedBy(access),
    ]);
    const buffer = await renderSalesReportPdf(report, {
      generatedBy,
      generatedAt: new Date(),
    });
    return this.files.pdf({
      label: 'Sales report (PDF)',
      nameParts: this.nameParts(report),
      branchId: report.branch?.id,
      filters: { ...query, period: report.period },
      buffer,
    });
  }

  private nameParts(report: SalesReport) {
    return [
      'sales-report',
      report.branch?.code || report.branch?.name || 'all-branches',
      this.files.range(report.range.from, report.range.to),
    ];
  }

  private rows(report: SalesReport): CsvRow[] {
    const h = report.headline;
    const p = report.previous;
    const c = report.changes;
    const scope = report.scope_label;
    const rows: CsvRow[] = [
      {
        section: 'Report',
        item: scope,
        metric: 'From',
        value: report.range.from,
        previous: report.previous_range.from,
      },
      {
        section: 'Report',
        item: scope,
        metric: 'To',
        value: report.range.to,
        previous: report.previous_range.to,
      },
      {
        section: 'Summary',
        item: scope,
        metric: 'Gross sales',
        value: h.gross_sales,
        previous: p.gross_sales,
        change: c.gross_sales,
      },
      {
        section: 'Summary',
        item: scope,
        metric: 'Voided sales',
        value: h.void_amount,
        previous: p.void_amount,
        change: c.void_amount,
      },
      {
        section: 'Summary',
        item: scope,
        metric: 'Voided sales count',
        value: h.void_count,
        previous: p.void_count,
      },
      {
        section: 'Summary',
        item: scope,
        metric: 'Net sales',
        value: h.net_sales,
        previous: p.net_sales,
        change: c.net_sales,
      },
      {
        section: 'Summary',
        item: scope,
        metric: 'Sales count',
        value: h.sales_count,
        previous: p.sales_count,
        change: c.sales_count,
      },
      {
        section: 'Summary',
        item: scope,
        metric: 'Average sale',
        value: h.average_sale,
        previous: p.average_sale,
        change: c.average_sale,
      },
      {
        section: 'Summary',
        item: scope,
        metric: 'Items sold',
        value: h.items_sold,
        previous: p.items_sold,
      },
    ];
    if (report.show_costs)
      rows.push(
        {
          section: 'Profit',
          item: scope,
          metric: 'Food cost',
          value: h.food_cost,
          previous: p.food_cost,
        },
        {
          section: 'Profit',
          item: scope,
          metric: 'Gross profit',
          value: h.gross_profit,
          previous: p.gross_profit,
          change: c.gross_profit,
        },
        {
          section: 'Profit',
          item: scope,
          metric: 'Food cost %',
          value: h.food_cost_percent,
          previous: p.food_cost_percent,
          change:
            c.food_cost_percent_points && `${c.food_cost_percent_points} pts`,
        },
        {
          section: 'Profit',
          item: scope,
          metric: 'Cost coverage %',
          value: h.cost_coverage_percent,
          previous: p.cost_coverage_percent,
        },
        {
          section: 'Stock',
          item: scope,
          metric: 'Waste value',
          value: report.stock.waste_value,
        },
        {
          section: 'Stock',
          item: scope,
          metric: 'Count variance value',
          value: report.stock.variance_value,
        },
      );
    rows.push(
      {
        section: 'Stock',
        item: scope,
        metric: 'Approved daily reports',
        value: report.stock.approved_reports,
      },
      {
        section: 'Cash',
        item: scope,
        metric: 'Closed shifts',
        value: report.cash.closed_shifts,
      },
      {
        section: 'Cash',
        item: scope,
        metric: 'Cash over/short (net)',
        value: report.cash.cash_difference,
      },
      {
        section: 'Cash',
        item: scope,
        metric: 'Short amount',
        value: report.cash.short_amount,
      },
      {
        section: 'Cash',
        item: scope,
        metric: 'Short shifts',
        value: report.cash.short_shifts,
      },
      {
        section: 'Cash',
        item: scope,
        metric: 'Over amount',
        value: report.cash.over_amount,
      },
      {
        section: 'Cash',
        item: scope,
        metric: 'Over shifts',
        value: report.cash.over_shifts,
      },
    );
    const add = (
      section: string,
      item: string,
      values: Record<string, string | number | null>,
    ) => {
      for (const [metric, value] of Object.entries(values))
        rows.push({ section, item, metric, value });
    };
    const profit = (row: {
      food_cost: string | null;
      gross_profit: string | null;
    }): Record<string, string | null> =>
      report.show_costs
        ? { 'Food cost': row.food_cost, 'Gross profit': row.gross_profit }
        : {};
    for (const row of report.by_branch)
      add('Branches', row.branch_name, {
        Sales: row.sales_count,
        'Net sales': row.net_sales,
        'Average sale': row.average_sale,
        ...profit(row),
        'Cash over/short': row.cash_difference,
      });
    for (const row of report.by_payment)
      add('Payment methods', row.name, {
        Sales: row.sales_count,
        Amount: row.amount,
        'Share %': row.share_percent,
      });
    for (const row of report.by_service)
      add('Service', serviceLabel(row.service_type), {
        Sales: row.sales_count,
        Amount: row.amount,
        'Share %': row.share_percent,
      });
    for (const row of report.by_category)
      add('Categories', row.name, {
        Quantity: row.quantity,
        'Net sales': row.net_sales,
        ...profit(row),
        'Share %': row.share_percent,
      });
    for (const row of report.top_products)
      add('Top products', row.name, {
        Quantity: row.quantity,
        'Net sales': row.net_sales,
        ...profit(row),
      });
    for (const row of report.daily)
      add('Day by day', row.date, {
        Sales: row.sales_count,
        'Net sales': row.net_sales,
        ...profit(row),
      });
    return rows;
  }
}
