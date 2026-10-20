import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BusinessDayController } from './business-day.controller';
import { BusinessDayRepository } from './business-day.repository';
import { BusinessDayService } from './business-day.service';

@Module({
  imports: [AuthModule],
  controllers: [BusinessDayController],
  providers: [BusinessDayRepository, BusinessDayService],
})
export class BusinessDayModule {}
