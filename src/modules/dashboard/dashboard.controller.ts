import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { RequirePermission } from '../../common/decorators/access-policy.decorator';
import { CurrentAccessContext } from '../../common/decorators/current-access-context.decorator';
import { AccessControlGuard } from '../../common/guards/access-control.guard';
import { AuthGatewayGuard } from '../../common/guards/auth-gateway.guard';
import { AuthGuard } from '../../common/guards/auth.guard';
import type { AccessContext } from '../access-control/access-control.types';
import { DashboardTodayService } from './dashboard-today.service';
import { DashboardService } from './dashboard.service';
import {
  DashboardOverviewQueryDto,
  DashboardTodayQueryDto,
} from './dto/dashboard-query.dto';

@Controller('dashboard')
@UseGuards(AuthGatewayGuard, AuthGuard, AccessControlGuard)
export class DashboardController {
  constructor(
    private readonly service: DashboardService,
    private readonly todayService: DashboardTodayService,
  ) {}

  @Get('overview')
  @RequirePermission('dashboard.global_read')
  overview(@Query() query: DashboardOverviewQueryDto) {
    return this.service.overview(query);
  }

  @Get('today')
  @RequirePermission('dashboard.read')
  today(
    @Query() query: DashboardTodayQueryDto,
    @CurrentAccessContext() access: AccessContext,
  ) {
    return this.todayService.today(query.branch_id, access);
  }
}
