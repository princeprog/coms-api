import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BranchDashboardController } from './branch-dashboard.controller';
import { DashboardController } from './dashboard.controller';
import { DashboardRepository } from './dashboard.repository';
import { DashboardService } from './dashboard.service';

@Module({
  imports: [AuthModule],
  controllers: [DashboardController, BranchDashboardController],
  providers: [DashboardRepository, DashboardService],
})
export class DashboardModule {}
