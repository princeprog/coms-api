import { Injectable } from '@nestjs/common';
import type { AccessContext } from '../access-control/access-control.types';
import { dashboardCan, dashboardScope } from './dashboard-access';
import {
  DashboardExceptionsRepository,
  type ExceptionWeekRow,
} from './dashboard-exceptions.repository';

type BranchTrend = {
  branch_id: string;
  branch_name: string;
  weeks: ReturnType<typeof visibleWeek>[];
};

function visibleWeek(
  row: ExceptionWeekRow,
  show: {
    shortages: boolean;
    values: boolean;
    cash: boolean;
    receiving: boolean;
  },
) {
  return {
    week_start: row.week_start,
    shortage_lines: show.shortages ? row.shortage_lines : null,
    uncosted_shortage_lines:
      show.shortages && show.values ? row.uncosted_shortage_lines : null,
    shortage_value: show.shortages && show.values ? row.shortage_value : null,
    cash_short_shifts: show.cash ? row.cash_short_shifts : null,
    cash_short_amount: show.cash ? row.cash_short_amount : null,
    receiving_differences: show.receiving ? row.receiving_differences : null,
    void_count: row.void_count,
    void_amount: row.void_amount,
  };
}

@Injectable()
export class DashboardExceptionsService {
  constructor(private readonly repository: DashboardExceptionsRepository) {}

  async exceptions(branchId: string | undefined, access: AccessContext) {
    const scope = dashboardScope(access, branchId);
    const can = dashboardCan(access);
    const show = {
      shortages: can('daily_reports.read'),
      values: can('costs.read'),
      cash: can('shifts.read'),
      receiving: can('dispatches.read'),
    };
    // Per-person cash and void history is shift accountability data.
    const [rows, cashiers] = await Promise.all([
      this.repository.weekly(scope),
      show.cash ? this.repository.cashiers(scope) : Promise.resolve(null),
    ]);
    const branches = new Map<string, BranchTrend & { active: boolean }>();
    for (const row of rows) {
      const branch = branches.get(row.branch_id) ?? {
        branch_id: row.branch_id,
        branch_name: row.branch_name,
        active: row.branch_status === 'active',
        weeks: [],
      };
      branch.weeks.push(visibleWeek(row, show));
      branches.set(row.branch_id, branch);
    }
    const hasActivity = (branch: BranchTrend) =>
      branch.weeks.some((week) =>
        [
          week.shortage_lines,
          week.cash_short_shifts,
          week.receiving_differences,
          week.void_count,
        ].some((value) => (value ?? 0) > 0),
      );
    return {
      week_starts: [...new Set(rows.map((row) => row.week_start))],
      access: {
        shortages: show.shortages,
        shortage_values: show.shortages && show.values,
        cash: show.cash,
        receiving: show.receiving,
        cashiers: show.cash,
      },
      // Inactive branches stay only while they have exceptions to explain.
      branches: [...branches.values()]
        .filter((branch) => branch.active || hasActivity(branch))
        .map(({ active: _active, ...branch }) => branch),
      cashiers,
    };
  }
}
