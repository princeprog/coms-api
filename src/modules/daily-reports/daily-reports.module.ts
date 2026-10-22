import { NotificationsModule } from '../notifications/notifications.module';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ExportsModule } from '../exports/exports.module';
import { DailyReportExportRepository } from './daily-report-export.repository';
import { DailyReportExportService } from './daily-report-export.service';
import { DailyReportDirectoryController } from './daily-report-directory.controller';
import { DailyReportDirectoryRepository } from './daily-report-directory.repository';
import { DailyReportsController } from './daily-reports.controller';
import { DailyReportsRepository } from './daily-reports.repository';
import { DailyReportsService } from './daily-reports.service';

@Module({
  imports: [AuthModule, NotificationsModule, ExportsModule],
  controllers: [DailyReportsController, DailyReportDirectoryController],
  providers: [
    DailyReportsRepository,
    DailyReportDirectoryRepository,
    DailyReportsService,
    DailyReportExportRepository,
    DailyReportExportService,
  ],
})
export class DailyReportsModule {}
