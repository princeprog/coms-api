import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NotificationWriterRepository } from './notification-writer.repository';
import { NotificationsController } from './notifications.controller';
import { NotificationsRepository } from './notifications.repository';
import { NotificationsService } from './notifications.service';

@Module({
  imports: [AuthModule],
  controllers: [NotificationsController],
  providers: [
    NotificationWriterRepository,
    NotificationsRepository,
    NotificationsService,
  ],
  exports: [NotificationWriterRepository],
})
export class NotificationsModule {}
