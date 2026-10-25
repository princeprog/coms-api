import { Injectable } from '@nestjs/common';
import { dashboardScope, isSuperAdmin } from './dashboard-access';
import type { AccessContext } from '../access-control/access-control.types';
import type { PermissionKey } from '../access-control/permission-catalog';
import { SHORTAGE_WINDOW_DAYS } from './dashboard-report-health.repository';
import {
  ATTENTION_KEYS,
  DashboardTodayRepository,
  type AttentionKey,
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
  commissary_stock_below_zero: 'inventory.commissary_read',
  branch_stock_low: 'inventory.read',
  commissary_stock_low: 'inventory.commissary_read',
  reports_to_review: 'daily_reports.read',
  reports_returned: 'daily_reports.read',
  reports_missing: 'daily_reports.read',
};

function percentChange(current: string | number, previous: string | number) {
  const before = Number(previous);
  if (!before) return null;
  return String(Math.round(((Number(current) - before) / before) * 1000) / 10);
}

@Injectable()
export class DashboardTodayService {
  constructor(private readonly repository: DashboardTodayRepository) {}

  async today(branchId: string | undefined, access: AccessContext) {
    const scope = dashboardScope(access, branchId);
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
      progress,
      shortages,
      backlog,
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
      can('daily_reports.read')
        ? this.repository.reportProgress(scope)
        : Promise.resolve([]),
      can('daily_reports.read')
        ? this.repository.countShortages(scope)
        : Promise.resolve({ branches: [], items: [] }),
      can('daily_reports.read')
        ? this.repository.reportBacklog(scope)
        : Promise.resolve({ total: 0, items: [] }),
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
    const priorities = new Map<string, number>();
    for (const row of progress) {
      const weight =
        row.status === 'RETURNED'
          ? 4
          : row.status === 'SUBMITTED'
            ? 3
            : row.period === 'yesterday' &&
                (row.status === 'DRAFT' ||
                  (row.status === 'MISSING' && row.had_sales))
              ? 2
              : 0;
      priorities.set(
        row.branch_id,
        Math.max(priorities.get(row.branch_id) ?? 0, weight),
      );
    }
    return {
      workspace:
        superAdmin || can('dashboard.global_read') ? 'overview' : 'branch',
      access: {
        reports: can('daily_reports.read'),
        shifts: can('shifts.read'),
        sales: can('sales_report.read'),
        dispatches: can('dispatches.read'),
      },
      submission_checklist_bypassed: process.env.NODE_ENV === 'development',
      report_progress: progress,
      // Values are stock cost, so they follow the cost permission.
      count_shortages: {
        days: SHORTAGE_WINDOW_DAYS,
        branches: shortages.branches.map((row) => ({
          ...row,
          shortage_value: showCosts ? row.shortage_value : null,
        })),
        items: shortages.items.map((row) => ({
          ...row,
          shortage_value: showCosts ? row.shortage_value : null,
        })),
      },
      report_backlog: backlog,
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
      ).map((key) => {
        // Suppress the details as well as the count outside commissary scope.
        const item =
          key.startsWith('commissary_') && branchId
            ? undefined
            : attention.find((row) => row.key === key);
        return (
          item ?? {
            key,
            count: 0,
            branch_count: 0,
            oldest_at: null,
            amount: null,
            example: null,
          }
        );
      }),
      branches: branches
        .map(({ yesterday_sales_count: sold, ...row }) => ({
          ...row,
          net_sales_change: percentChange(
            row.net_sales,
            row.last_week_net_sales,
          ),
          shift_id: can('shifts.read') ? row.shift_id : null,
          // A missing report only matters when the branch sold something.
          yesterday_report_status: can('daily_reports.read')
            ? (row.yesterday_report_status ?? (sold > 0 ? 'MISSING' : null))
            : null,
        }))
        .sort(
          (a, b) =>
            (priorities.get(b.branch_id) ?? 0) -
            (priorities.get(a.branch_id) ?? 0),
        ),
      last_7_days: days.map((row) => ({
        ...row,
        food_cost: showCosts ? row.food_cost : null,
        gross_profit: showCosts ? row.gross_profit : null,
      })),
      top_products_today: topProducts,
      hourly: hours,
    };
  }
}
