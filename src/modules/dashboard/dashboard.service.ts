import { Injectable } from '@nestjs/common';
import type { DashboardDateQuery } from './dashboard-date-range';
import { resolveDashboardDateRange } from './dashboard-date-range';
import type { DashboardOverviewQueryDto } from './dto/dashboard-query.dto';
import { DashboardRepository } from './dashboard.repository';

@Injectable()
export class DashboardService {
  constructor(private readonly repository: DashboardRepository) {}

  overview(query: DashboardOverviewQueryDto) {
    return this.repository.overview(
      resolveDashboardDateRange(query),
      query.branch_id,
    );
  }

  branchDashboard(branchId: string, query: DashboardDateQuery) {
    return this.repository.overview(resolveDashboardDateRange(query), branchId);
  }
}
