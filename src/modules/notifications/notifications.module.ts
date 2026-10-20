import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NotificationWriterRepository } from './notification-writer.repository';
import { NotificationsController } from './notifications.controller';
import { NotificationsRepository } from './notifications.repository';
import { NotificationsService } from './notifications.service';
import { ReceivingRemindersService } from './receiving-reminders.service';
import { ReceivingRemindersRepository } from './receiving-reminders.repository';

@Module({
  imports: [AuthModule],
  controllers: [NotificationsController],
  providers: [
    ReceivingRemindersRepository,
    ReceivingRemindersService,
    NotificationWriterRepository,
    NotificationsRepository,
    NotificationsService,
  ],
  exports: [NotificationWriterRepository],
})
export class NotificationsModule {}
