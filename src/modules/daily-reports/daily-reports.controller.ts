import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentAccessContext } from '../../common/decorators/current-access-context.decorator';
import {
  RequireBranchScope,
  RequirePermission,
} from '../../common/decorators/access-policy.decorator';
import type { AccessContext } from '../access-control/access-control.types';
import { AccessControlGuard } from '../../common/guards/access-control.guard';
import { AuthGatewayGuard } from '../../common/guards/auth-gateway.guard';
import { AuthGuard } from '../../common/guards/auth.guard';
import { CreateDailyReportDto } from './dto/create-daily-report.dto';
import { DailyReportQueryDto } from './dto/daily-report-query.dto';
import { ReturnDailyReportDto } from './dto/return-daily-report.dto';
import { UpdateDailyReportDto } from './dto/update-daily-report.dto';
import { DailyReportsService } from './daily-reports.service';

@Controller('branches/:branchId/daily-reports')
@UseGuards(AuthGatewayGuard, AuthGuard, AccessControlGuard)
@RequireBranchScope()
export class DailyReportsController {
  constructor(private readonly service: DailyReportsService) {}

  @Get()
  @RequirePermission('daily_reports.read')
  list(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Query() query: DailyReportQueryDto,
  ) {
    return this.service.list(branchId, query);
  }

  @Post()
  @RequirePermission('daily_reports.create')
  create(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Body() input: CreateDailyReportDto,
    @CurrentAccessContext() access: AccessContext,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    return this.service.create(branchId, input, access.userId, idempotencyKey);
  }

  @Get(':reportId')
  @RequirePermission('daily_reports.read')
  get(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Param('reportId', ParseUUIDPipe) reportId: string,
  ) {
    return this.service.get(branchId, reportId);
  }

  @Put(':reportId')
  @RequirePermission('daily_reports.update')
  update(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Param('reportId', ParseUUIDPipe) reportId: string,
    @Body() input: UpdateDailyReportDto,
    @CurrentAccessContext() access: AccessContext,
  ) {
    return this.service.update(branchId, reportId, input, access.userId);
  }

  @Post(':reportId/submit')
  @HttpCode(200)
  @RequirePermission('daily_reports.submit')
  submit(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Param('reportId', ParseUUIDPipe) reportId: string,
    @CurrentAccessContext() access: AccessContext,
  ) {
    return this.service.submit(branchId, reportId, access.userId);
  }

  @Post(':reportId/return')
  @HttpCode(200)
  @RequirePermission('daily_reports.return')
  returnForCorrection(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Param('reportId', ParseUUIDPipe) reportId: string,
    @Body() input: ReturnDailyReportDto,
    @CurrentAccessContext() access: AccessContext,
  ) {
    return this.service.returnForCorrection(
      branchId,
      reportId,
      input,
      access.userId,
    );
  }

  @Post(':reportId/approve')
  @HttpCode(200)
  @RequirePermission('daily_reports.approve')
  approve(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Param('reportId', ParseUUIDPipe) reportId: string,
    @CurrentAccessContext() access: AccessContext,
  ) {
    return this.service.approve(branchId, reportId, access.userId);
  }
}
