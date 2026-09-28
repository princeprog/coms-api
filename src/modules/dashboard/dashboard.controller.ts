import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { RequirePermission } from '../../common/decorators/access-policy.decorator';
import { AccessControlGuard } from '../../common/guards/access-control.guard';
import { AuthGatewayGuard } from '../../common/guards/auth-gateway.guard';
import { AuthGuard } from '../../common/guards/auth.guard';
import { DashboardService } from './dashboard.service';
import { DashboardOverviewQueryDto } from './dto/dashboard-query.dto';

@Controller('dashboard')
@UseGuards(AuthGatewayGuard, AuthGuard, AccessControlGuard)
export class DashboardController {
  constructor(private readonly service: DashboardService) {}

  @Get('overview')
  @RequirePermission('dashboard.global_read')
  overview(@Query() query: DashboardOverviewQueryDto) {
    return this.service.overview(query);
  }
}
