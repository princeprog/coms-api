import { Body, Controller, Delete, Get, Put, UseGuards } from '@nestjs/common';
import { CurrentAccessContext } from '../../common/decorators/current-access-context.decorator';
import { RequireSuperAdmin } from '../../common/decorators/access-policy.decorator';
import { AccessControlGuard } from '../../common/guards/access-control.guard';
import { AuthGatewayGuard } from '../../common/guards/auth-gateway.guard';
import { AuthGuard } from '../../common/guards/auth.guard';
import type { AccessContext } from '../access-control/access-control.types';
import { BusinessDayService } from './business-day.service';
import { UpdateBusinessDayDto } from './dto/update-business-day.dto';

@Controller('settings/business-day')
@UseGuards(AuthGatewayGuard, AuthGuard, AccessControlGuard)
export class BusinessDayController {
  constructor(private readonly service: BusinessDayService) {}

  // Every signed-in role needs today's business date for reports and selling.
  @Get()
  settings() {
    return this.service.settings();
  }

  @Put()
  @RequireSuperAdmin()
  schedule(
    @Body() input: UpdateBusinessDayDto,
    @CurrentAccessContext() access: AccessContext,
  ) {
    return this.service.schedule(input, access.userId);
  }

  @Delete('scheduled')
  @RequireSuperAdmin()
  cancelScheduled() {
    return this.service.cancelScheduled();
  }
}
