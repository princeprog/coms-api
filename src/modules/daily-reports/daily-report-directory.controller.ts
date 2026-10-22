import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { CurrentAccessContext } from '../../common/decorators/current-access-context.decorator';
import { RequirePermission } from '../../common/decorators/access-policy.decorator';
import { AccessControlGuard } from '../../common/guards/access-control.guard';
import { AuthGatewayGuard } from '../../common/guards/auth-gateway.guard';
import { AuthGuard } from '../../common/guards/auth.guard';
import type { AccessContext } from '../access-control/access-control.types';
import { DailyReportDirectoryQueryDto } from './dto/daily-report-directory-query.dto';
import { DailyReportsService } from './daily-reports.service';

/** Cross-branch report list; branch scope is applied in the service. */
@Controller('daily-reports')
@UseGuards(AuthGatewayGuard, AuthGuard, AccessControlGuard)
export class DailyReportDirectoryController {
  constructor(private readonly service: DailyReportsService) {}

  @Get()
  @RequirePermission('daily_reports.read')
  list(
    @Query() query: DailyReportDirectoryQueryDto,
    @CurrentAccessContext() access: AccessContext,
  ) {
    return this.service.directory(query, access);
  }
}
