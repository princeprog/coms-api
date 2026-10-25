import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
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
import { ShiftTemplateDto, UpdateShiftTemplateDto } from './dto/schedule.dto';
import { SchedulesService } from './schedules.service';

@Controller('branches/:branchId/shift-templates')
@UseGuards(AuthGatewayGuard, AuthGuard, AccessControlGuard)
@RequireBranchScope()
export class ShiftTemplatesController {
  constructor(private readonly service: SchedulesService) {}

  @Get()
  @RequirePermission('schedules.read')
  list(@Param('branchId', ParseUUIDPipe) branchId: string) {
    return this.service.listTemplates(branchId);
  }

  @Post()
  @RequirePermission('schedules.manage')
  create(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Body() input: ShiftTemplateDto,
    @CurrentAccessContext() access: AccessContext,
  ) {
    return this.service.createTemplate(branchId, input, access.userId);
  }

  @Patch(':templateId')
  @RequirePermission('schedules.manage')
  update(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Param('templateId', ParseUUIDPipe) templateId: string,
    @Body() input: UpdateShiftTemplateDto,
  ) {
    return this.service.updateTemplate(branchId, templateId, input);
  }

  @Post(':templateId/deactivate')
  @RequirePermission('schedules.manage')
  deactivate(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Param('templateId', ParseUUIDPipe) templateId: string,
  ) {
    return this.service.setTemplateActive(branchId, templateId, false);
  }

  @Post(':templateId/reactivate')
  @RequirePermission('schedules.manage')
  reactivate(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Param('templateId', ParseUUIDPipe) templateId: string,
  ) {
    return this.service.setTemplateActive(branchId, templateId, true);
  }
}
