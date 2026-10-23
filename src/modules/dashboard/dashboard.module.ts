import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BranchDashboardController } from './branch-dashboard.controller';
import { DashboardController } from './dashboard.controller';
import { DashboardRepository } from './dashboard.repository';
import { DashboardService } from './dashboard.service';
import { DashboardExceptionsRepository } from './dashboard-exceptions.repository';
import { DashboardExceptionsService } from './dashboard-exceptions.service';
import { DashboardTodayRepository } from './dashboard-today.repository';
import { DashboardTodayService } from './dashboard-today.service';

@Module({
  imports: [AuthModule],
  controllers: [DashboardController, BranchDashboardController],
  providers: [
    DashboardRepository,
    DashboardService,
    DashboardTodayRepository,
    DashboardTodayService,
    DashboardExceptionsRepository,
    DashboardExceptionsService,
  ],
})
export class DashboardModule {}
