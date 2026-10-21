import { ForbiddenException, Injectable } from '@nestjs/common';
import type { AccessContext } from '../access-control/access-control.types';
import type { SalesReportQueryDto } from './dto/sales-report-query.dto';
import {
  percentChange,
  pointChange,
  resolveReportPeriod,
} from './sales-report-period';
import {
  SalesReportRepository,
  type ReportScope,
  type ReportTotals,
} from './sales-report.repository';

const COST_FIELDS = [
  'food_cost',
  'gross_profit',
  'food_cost_percent',
  'cost_coverage_percent',
] as const;

function isSuperAdmin(access: AccessContext) {
  return Boolean(
    access.role?.isSystem &&
    access.role.isActive &&
    access.role.code === 'SUPER_ADMIN',
  );
}

type Costed = Partial<Record<'food_cost' | 'gross_profit', string | null>>;

@Injectable()
export class SalesReportService {
  constructor(private readonly repository: SalesReportRepository) {}

  async report(query: SalesReportQueryDto, access: AccessContext) {
    const period = resolveReportPeriod(query);
    const scope = this.scope(access, query.branch_id);
    const showCosts =
      isSuperAdmin(access) || access.permissions.includes('costs.read');
    const [current, previous, breakdowns, cashAndStock, options] =
      await Promise.all([
        this.repository.totals(period.range, scope),
        this.repository.totals(period.previousRange, scope),
        this.repository.breakdowns(period.range, scope),
        this.repository.cashAndStock(period.range, scope),
        this.repository.branchOptions(
          isSuperAdmin(access) ? null : access.branchIds,
        ),
      ]);
    const branch = query.branch_id
      ? (options.find((option) => option.id === query.branch_id) ?? null)
      : null;
    const hide = <T extends Costed>(row: T): T =>
      showCosts ? row : { ...row, food_cost: null, gross_profit: null };
    const { waste_value, variance_value, approved_reports, ...cash } =
      cashAndStock;
    return {
      period: period.period,
      period_range: period.periodRange,
      range: period.range,
      previous_range: period.previousRange,
      in_progress: period.inProgress,
      branch: branch && { id: branch.id, name: branch.name, code: branch.code },
      scope_label: branch
        ? branch.name
        : isSuperAdmin(access)
          ? 'All branches'
          : options.length === 1
            ? options[0].name
            : 'All assigned branches',
      branch_options: options.map(({ id, name, status }) => ({
        id,
        name,
        status,
      })),
      show_costs: showCosts,
      headline: this.totals(current, showCosts),
      previous: this.totals(previous, showCosts),
      changes: {
        gross_sales: percentChange(current.gross_sales, previous.gross_sales),
        net_sales: percentChange(current.net_sales, previous.net_sales),
        sales_count: percentChange(
          String(current.sales_count),
          String(previous.sales_count),
        ),
        average_sale: percentChange(
          current.average_sale ?? '0',
          previous.average_sale ?? '0',
        ),
        void_amount: percentChange(current.void_amount, previous.void_amount),
        gross_profit: showCosts
          ? percentChange(current.gross_profit, previous.gross_profit)
          : null,
        food_cost_percent_points: showCosts
          ? pointChange(current.food_cost_percent, previous.food_cost_percent)
          : null,
      },
      cash,
      stock: {
        approved_reports,
        waste_value: showCosts ? waste_value : null,
        variance_value: showCosts ? variance_value : null,
      },
      by_branch: breakdowns.byBranch.map(hide),
      by_payment: breakdowns.byPayment,
      by_service: breakdowns.byService,
      by_category: breakdowns.byCategory.map(hide),
      top_products: breakdowns.topProducts.map(hide),
      daily: period.period === 'day' ? [] : breakdowns.daily.map(hide),
    };
  }

  generatedBy(access: AccessContext) {
    return this.repository.userName(access.userId);
  }

  private totals(totals: ReportTotals, showCosts: boolean) {
    if (showCosts) return totals;
    const hidden: Record<string, null> = {};
    for (const field of COST_FIELDS) hidden[field] = null;
    return { ...totals, ...hidden } as Omit<
      ReportTotals,
      (typeof COST_FIELDS)[number]
    > &
      Record<(typeof COST_FIELDS)[number], string | null>;
  }

  // Super Admin sees every branch; other readers only their assigned branches.
  private scope(access: AccessContext, branchId?: string): ReportScope {
    if (isSuperAdmin(access)) return branchId ? [branchId] : null;
    if (!access.branchIds.length)
      throw new ForbiddenException('Branch access required');
    if (branchId) {
      if (!access.branchIds.includes(branchId))
        throw new ForbiddenException('Branch access required');
      return [branchId];
    }
    return access.branchIds;
  }
}

export type SalesReport = Awaited<ReturnType<SalesReportService['report']>>;
