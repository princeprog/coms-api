import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ShiftsController } from './shifts.controller';
import { MyShiftController } from './my-shift.controller';
import { ShiftsRepository } from './shifts.repository';
import { ShiftsService } from './shifts.service';

@Module({
  imports: [AuthModule, NotificationsModule],
  controllers: [ShiftsController, MyShiftController],
  providers: [ShiftsRepository, ShiftsService],
})
export class ShiftsModule {}
