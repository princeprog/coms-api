import { ForbiddenException, Injectable } from '@nestjs/common';
import type { AccessContext } from '../access-control/access-control.types';
import type { PermissionKey } from '../access-control/permission-catalog';
import {
  ATTENTION_KEYS,
  DashboardTodayRepository,
  type AttentionKey,
  type TodayScope,
} from './dashboard-today.repository';

// Who may see each attention item; Super Admin sees them all.
const ATTENTION_PERMISSION: Record<AttentionKey, PermissionKey> = {
  deliveries_overdue: 'dispatches.read',
  deliveries_in_transit: 'dispatches.read',
  late_counts_to_review: 'dispatches.read',
  open_discrepancies: 'dispatches.read',
  // Drafts are commissary work, so only people who send dispatches see them.
  dispatches_draft: 'dispatches.dispatch',
  shifts_to_review: 'shifts.read',
  shifts_open_past_day: 'shifts.read',
  cash_shortages: 'shifts.read',
  stock_below_zero: 'inventory.read',
  reports_to_review: 'daily_reports.read',
  reports_returned: 'daily_reports.read',
  reports_missing: 'daily_reports.read',
  products_incomplete_costs: 'costs.read',
};

function isSuperAdmin(access: AccessContext) {
  return Boolean(
    access.role?.isSystem &&
    access.role.isActive &&
    access.role.code === 'SUPER_ADMIN',
  );
}

function percentChange(current: string | number, previous: string | number) {
  const before = Number(previous);
  if (!before) return null;
  return String(Math.round(((Number(current) - before) / before) * 1000) / 10);
}

@Injectable()
export class DashboardTodayService {
  constructor(private readonly repository: DashboardTodayRepository) {}

  async today(branchId: string | undefined, access: AccessContext) {
    const scope = this.scope(access, branchId);
    const superAdmin = isSuperAdmin(access);
    const can = (permission: PermissionKey) =>
      superAdmin || access.permissions.includes(permission);
    const showCosts = can('costs.read');
    const [
      day,
      totals,
      attention,
      branches,
      days,
      topProducts,
      options,
      hours,
    ] = await Promise.all([
      this.repository.businessDate(),
      this.repository.totals(scope),
      this.repository.attention(scope),
      this.repository.branches(scope),
      this.repository.lastSevenDays(scope),
      this.repository.topProductsToday(scope),
      this.repository.branchOptions(
        superAdmin || access.permissions.includes('dashboard.global_read')
          ? null
          : access.branchIds,
      ),
      this.repository.hourly(scope),
    ]);
    const branch = branchId
      ? options.find((option) => option.id === branchId)
      : undefined;
    const {
      yesterday_net_sales,
      yesterday_sales_count,
      last_week_net_sales,
      last_week_sales_count,
      food_cost,
      gross_profit,
      cost_coverage_percent,
      ...today
    } = totals;
    return {
      business_date: day.today,
      as_of: day.as_of,
      scope_label: branch
        ? branch.name
        : scope === null
          ? 'All branches'
          : options.length === 1
            ? options[0].name
            : 'All assigned branches',
      branch_options: options,
      show_costs: showCosts,
      today: {
        ...today,
        food_cost: showCosts ? food_cost : null,
        gross_profit: showCosts ? gross_profit : null,
        cost_coverage_percent: showCosts ? cost_coverage_percent : null,
      },
      // The same weekday is the fairer comparison; yesterday stays alongside.
      last_week_same_time: {
        net_sales: last_week_net_sales,
        sales_count: last_week_sales_count,
      },
      yesterday_same_time: {
        net_sales: yesterday_net_sales,
        sales_count: yesterday_sales_count,
      },
      changes: {
        net_sales: percentChange(today.net_sales, last_week_net_sales),
        sales_count: percentChange(today.sales_count, last_week_sales_count),
        net_sales_vs_yesterday: percentChange(
          today.net_sales,
          yesterday_net_sales,
        ),
      },
      attention: ATTENTION_KEYS.filter((key) =>
        can(ATTENTION_PERMISSION[key]),
      ).map((key) => ({ key, count: attention[key] })),
      branches: branches.map(({ yesterday_sales_count: sold, ...row }) => ({
        ...row,
        // A missing report only matters when the branch sold something.
        yesterday_report_status:
          row.yesterday_report_status ?? (sold > 0 ? 'MISSING' : null),
      })),
      last_7_days: days.map((row) => ({
        ...row,
        food_cost: showCosts ? row.food_cost : null,
        gross_profit: showCosts ? row.gross_profit : null,
      })),
      top_products_today: topProducts,
      hourly: hours,
    };
  }

  // Super Admin and global readers see every branch; others their own.
  private scope(access: AccessContext, branchId?: string): TodayScope {
    const global =
      isSuperAdmin(access) ||
      access.permissions.includes('dashboard.global_read');
    if (global) return branchId ? [branchId] : null;
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
