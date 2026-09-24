import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DailyReportsController } from './daily-reports.controller';
import { DailyReportsRepository } from './daily-reports.repository';
import { DailyReportsService } from './daily-reports.service';

@Module({
  imports: [AuthModule],
  controllers: [DailyReportsController],
  providers: [DailyReportsRepository, DailyReportsService],
})
export class DailyReportsModule {}
