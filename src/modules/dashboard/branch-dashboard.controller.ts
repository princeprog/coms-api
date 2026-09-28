import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import {
  RequireBranchScope,
  RequirePermission,
} from '../../common/decorators/access-policy.decorator';
import { AccessControlGuard } from '../../common/guards/access-control.guard';
import { AuthGatewayGuard } from '../../common/guards/auth-gateway.guard';
import { AuthGuard } from '../../common/guards/auth.guard';
import { DashboardService } from './dashboard.service';
import { DashboardQueryDto } from './dto/dashboard-query.dto';

@Controller('branches/:branchId/dashboard')
@UseGuards(AuthGatewayGuard, AuthGuard, AccessControlGuard)
export class BranchDashboardController {
  constructor(private readonly service: DashboardService) {}

  @Get()
  @RequirePermission('dashboard.read')
  @RequireBranchScope()
  dashboard(
    @Param('branchId') branchId: string,
    @Query() query: DashboardQueryDto,
  ) {
    return this.service.branchDashboard(branchId, query);
  }
}
