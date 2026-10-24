import { Injectable, NotFoundException } from '@nestjs/common';
import type { AccessContext } from '../access-control/access-control.types';
import type { NotificationQueryDto } from './dto/notification-query.dto';
import { NotificationsRepository } from './notifications.repository';
import { ReceivingRemindersService } from './receiving-reminders.service';

@Injectable()
export class NotificationsService {
  constructor(
    private readonly repository: NotificationsRepository,
    private readonly reminders: ReceivingRemindersService,
  ) {}
  async list(query: NotificationQueryDto, access: AccessContext) {
    await this.reminders.refreshOnRequest();
    return this.repository.list(query, access);
  }
  async unreadCount(access: AccessContext) {
    await this.reminders.refreshOnRequest();
    return this.repository.unreadCount(access);
  }
  async markRead(id: string, access: AccessContext) {
    const [result] = await this.repository.markRead(access, id);
    if (!result) throw new NotFoundException('Notification not found');
    return result;
  }
  async markAllRead(access: AccessContext) {
    await this.repository.markRead(access);
    return { updated: true };
  }
}
