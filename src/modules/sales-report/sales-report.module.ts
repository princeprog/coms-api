import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ExportsModule } from '../exports/exports.module';
import { SalesReportController } from './sales-report.controller';
import { SalesReportExportService } from './sales-report-export.service';
import { SalesReportRepository } from './sales-report.repository';
import { SalesReportService } from './sales-report.service';

@Module({
  imports: [AuthModule, ExportsModule],
  controllers: [SalesReportController],
  providers: [
    SalesReportRepository,
    SalesReportService,
    SalesReportExportService,
  ],
})
export class SalesReportModule {}
