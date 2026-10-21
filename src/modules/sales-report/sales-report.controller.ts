import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { RequirePermission } from '../../common/decorators/access-policy.decorator';
import { CurrentAccessContext } from '../../common/decorators/current-access-context.decorator';
import { AccessControlGuard } from '../../common/guards/access-control.guard';
import { AuthGatewayGuard } from '../../common/guards/auth-gateway.guard';
import { AuthGuard } from '../../common/guards/auth.guard';
import type { AccessContext } from '../access-control/access-control.types';
import { SalesReportQueryDto } from './dto/sales-report-query.dto';
import { SalesReportExportService } from './sales-report-export.service';
import { SalesReportService } from './sales-report.service';

@Controller('reports/sales')
@UseGuards(AuthGatewayGuard, AuthGuard, AccessControlGuard)
export class SalesReportController {
  constructor(
    private readonly service: SalesReportService,
    private readonly exports: SalesReportExportService,
  ) {}

  @Get()
  @RequirePermission('sales_report.read')
  report(
    @Query() query: SalesReportQueryDto,
    @CurrentAccessContext() access: AccessContext,
  ) {
    return this.service.report(query, access);
  }

  @Get('export')
  @RequirePermission('sales_report.read')
  csv(
    @Query() query: SalesReportQueryDto,
    @CurrentAccessContext() access: AccessContext,
  ) {
    return this.exports.csv(query, access);
  }

  @Get('pdf')
  @RequirePermission('sales_report.read')
  pdf(
    @Query() query: SalesReportQueryDto,
    @CurrentAccessContext() access: AccessContext,
  ) {
    return this.exports.pdf(query, access);
  }
}
