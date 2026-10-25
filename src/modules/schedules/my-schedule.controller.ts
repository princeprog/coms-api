import { Controller, Get, UseGuards } from '@nestjs/common';
import { CurrentAccessContext } from '../../common/decorators/current-access-context.decorator';
import { AccessControlGuard } from '../../common/guards/access-control.guard';
import { AuthGatewayGuard } from '../../common/guards/auth-gateway.guard';
import { AuthGuard } from '../../common/guards/auth.guard';
import type { AccessContext } from '../access-control/access-control.types';
import { SchedulesService } from './schedules.service';

/** Any active role may read their own upcoming shifts. */
@Controller('schedules')
@UseGuards(AuthGatewayGuard, AuthGuard, AccessControlGuard)
export class MyScheduleController {
  constructor(private readonly service: SchedulesService) {}

  @Get('mine')
  mine(@CurrentAccessContext() access: AccessContext) {
    return this.service.mine(access.userId);
  }
}
