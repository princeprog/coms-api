import { Injectable } from '@nestjs/common';
import { CsvExportService, exportPage } from '../exports/csv-export.service';
import type { AccessContext } from '../access-control/access-control.types';
import type {
  CostRangeQueryDto,
  ProductCostQueryDto,
  StockCostQueryDto,
} from './dto/cost-query.dto';
import { CostsService } from './costs.service';

@Injectable()
export class CostsExportService {
  constructor(
    private readonly costs: CostsService,
    private readonly csv: CsvExportService,
  ) {}

  async branchProfit(query: CostRangeQueryDto, access: AccessContext) {
    const result = await this.costs.branchProfit(query, access);
    const rows = [
      ...result.branches,
      { ...result.totals, branch_name: 'All branches' },
    ];
    return this.csv.file({
      label: 'Profit by branch',
      nameParts: [
        'profit-by-branch',
        this.csv.range(result.range.from, result.range.to),
      ],
      filters: query,
      total: rows.length,
      rows,
      columns: [
        { header: 'Branch', value: (row) => row.branch_name },
        { header: 'Sales', value: (row) => row.sales_count },
        { header: 'Net sales', value: (row) => row.net_sales },
        { header: 'Food cost', value: (row) => row.food_cost },
        { header: 'Gross profit', value: (row) => row.gross_profit },
        { header: 'Food cost %', value: (row) => row.food_cost_percent },
        {
          header: 'Cost coverage %',
          value: (row) => row.cost_coverage_percent,
        },
        { header: 'Waste value', value: (row) => row.waste_value },
        { header: 'Variance value', value: (row) => row.variance_value },
      ],
    });
  }

  async productProfit(query: CostRangeQueryDto, access: AccessContext) {
    const result = await this.costs.branchProductProfit(
      { ...query, ...exportPage },
      access,
    );
    return this.csv.file({
      label: 'Profit by product',
      nameParts: [
        'profit-by-product',
        query.branch_id ? await this.csv.branchCode(query.branch_id) : null,
        this.csv.range(result.range.from, result.range.to),
      ],
      branchId: query.branch_id,
      filters: query,
      total: result.total,
      rows: result.items,
      columns: [
        { header: 'Product', value: (row) => row.product_name },
        { header: 'Units sold', value: (row) => row.units_sold },
        { header: 'Net sales', value: (row) => row.net_sales },
        { header: 'Food cost', value: (row) => row.food_cost },
        { header: 'Gross profit', value: (row) => row.gross_profit },
        { header: 'Food cost %', value: (row) => row.food_cost_percent },
        { header: 'Fully costed', value: (row) => row.fully_costed },
      ],
    });
  }

  async productCosts(query: ProductCostQueryDto) {
    const result = await this.costs.productCosts({ ...query, ...exportPage });
    return this.csv.file({
      label: 'Product costs',
      nameParts: ['product-costs'],
      filters: query,
      total: result.total,
      rows: result.items,
      columns: [
        { header: 'Product', value: (row) => row.product_name },
        { header: 'Category', value: (row) => row.category_name },
        { header: 'Price', value: (row) => row.price },
        { header: 'Recipe lines', value: (row) => row.recipe_line_count },
        { header: 'Dine-in cost', value: (row) => row.dine_in_cost },
        { header: 'Takeout cost', value: (row) => row.takeout_cost },
        { header: 'Dine-in margin', value: (row) => row.dine_in_margin },
        { header: 'Takeout margin', value: (row) => row.takeout_margin },
        {
          header: 'Lowest margin %',
          value: (row) => row.lowest_margin_percent,
        },
        {
          header: 'Stock without cost',
          value: (row) => row.missing_cost_items,
        },
      ],
    });
  }

  async stockCosts(query: StockCostQueryDto) {
    const result = await this.costs.stockCosts({ ...query, ...exportPage });
    return this.csv.file({
      label: 'Stock costs',
      nameParts: ['stock-costs'],
      filters: query,
      total: result.total,
      rows: result.items,
      columns: [
        { header: 'Stock item', value: (row) => row.stock_item_name },
        { header: 'Category', value: (row) => row.category },
        { header: 'Unit', value: (row) => row.unit },
        { header: 'Average cost', value: (row) => row.average_unit_cost },
        { header: 'Last receipt cost', value: (row) => row.last_unit_cost },
        { header: 'Last received', value: (row) => row.last_received_at },
        {
          header: 'Source',
          value: (row) =>
            row.cost_source === 'RECEIPT'
              ? 'Receipts'
              : row.cost_source === 'MANUAL'
                ? 'Set manually'
                : 'No cost yet',
        },
      ],
    });
  }
}
