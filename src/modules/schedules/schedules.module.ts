import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MyScheduleController } from './my-schedule.controller';
import { SchedulesController } from './schedules.controller';
import { SchedulesRepository } from './schedules.repository';
import { SchedulesService } from './schedules.service';
import { ShiftTemplatesController } from './shift-templates.controller';
import { ShiftTemplatesRepository } from './shift-templates.repository';

@Module({
  imports: [AuthModule],
  controllers: [
    ShiftTemplatesController,
    SchedulesController,
    MyScheduleController,
  ],
  providers: [ShiftTemplatesRepository, SchedulesRepository, SchedulesService],
})
export class SchedulesModule {}
