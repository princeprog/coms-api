import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentAccessContext } from '../../common/decorators/current-access-context.decorator';
import { AuthGatewayGuard } from '../../common/guards/auth-gateway.guard';
import { AuthGuard } from '../../common/guards/auth.guard';
import { AccessControlGuard } from '../../common/guards/access-control.guard';
import type { AccessContext } from '../access-control/access-control.types';
import { NotificationQueryDto } from './dto/notification-query.dto';
import { NotificationsService } from './notifications.service';

@Controller('notifications')
@UseGuards(AuthGatewayGuard, AuthGuard, AccessControlGuard)
export class NotificationsController {
  constructor(private readonly service: NotificationsService) {}
  @Get()
  list(
    @Query() query: NotificationQueryDto,
    @CurrentAccessContext() access: AccessContext,
  ) {
    return this.service.list(query, access);
  }
  @Get('unread-count')
  unreadCount(@CurrentAccessContext() access: AccessContext) {
    return this.service.unreadCount(access);
  }
  @Patch('read-all')
  markAllRead(@CurrentAccessContext() access: AccessContext) {
    return this.service.markAllRead(access);
  }
  @Patch(':id/read')
  markRead(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAccessContext() access: AccessContext,
  ) {
    return this.service.markRead(id, access);
  }
}
