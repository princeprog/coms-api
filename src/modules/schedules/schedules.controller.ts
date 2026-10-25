import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentAccessContext } from '../../common/decorators/current-access-context.decorator';
import {
  RequireBranchScope,
  RequirePermission,
} from '../../common/decorators/access-policy.decorator';
import { AccessControlGuard } from '../../common/guards/access-control.guard';
import { AuthGatewayGuard } from '../../common/guards/auth-gateway.guard';
import { AuthGuard } from '../../common/guards/auth.guard';
import type { AccessContext } from '../access-control/access-control.types';
import {
  ScheduleExceptionDto,
  ScheduleWeekQueryDto,
  StaffPatternDto,
} from './dto/schedule.dto';
import { SchedulesService } from './schedules.service';

@Controller('branches/:branchId/schedule')
@UseGuards(AuthGatewayGuard, AuthGuard, AccessControlGuard)
@RequireBranchScope()
export class SchedulesController {
  constructor(private readonly service: SchedulesService) {}

  @Get()
  @RequirePermission('schedules.read')
  week(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Query() query: ScheduleWeekQueryDto,
  ) {
    return this.service.week(branchId, query.week);
  }

  @Put('pattern/:userId')
  @RequirePermission('schedules.manage')
  replacePattern(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() input: StaffPatternDto,
  ) {
    return this.service.replacePattern(branchId, userId, input);
  }

  @Post('exceptions')
  @RequirePermission('schedules.manage')
  addException(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Body() input: ScheduleExceptionDto,
    @CurrentAccessContext() access: AccessContext,
  ) {
    return this.service.addException(branchId, input, access.userId);
  }

  @Delete('exceptions/:exceptionId')
  @RequirePermission('schedules.manage')
  removeException(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Param('exceptionId', ParseUUIDPipe) exceptionId: string,
  ) {
    return this.service.removeException(branchId, exceptionId);
  }
}
