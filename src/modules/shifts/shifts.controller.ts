import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
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
  CashMovementDto,
  CloseShiftDto,
  ForceCloseShiftDto,
  OpenShiftDto,
  ReviewShiftDto,
  ShiftExplanationDto,
  ShiftQueryDto,
} from './dto/shift.dto';
import { ShiftsService } from './shifts.service';

@Controller('branches/:branchId/shifts')
@UseGuards(AuthGatewayGuard, AuthGuard, AccessControlGuard)
@RequireBranchScope()
export class ShiftsController {
  constructor(private readonly service: ShiftsService) {}

  @Get('current')
  @RequirePermission('shifts.read')
  current(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @CurrentAccessContext() access: AccessContext,
  ) {
    return this.service.current(branchId, access);
  }

  @Get()
  @RequirePermission('shifts.read')
  list(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Query() query: ShiftQueryDto,
  ) {
    return this.service.list(branchId, query);
  }

  @Get(':shiftId')
  @RequirePermission('shifts.read')
  find(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Param('shiftId', ParseUUIDPipe) shiftId: string,
    @CurrentAccessContext() access: AccessContext,
  ) {
    return this.service.find(branchId, shiftId, access);
  }

  @Post()
  @RequirePermission('shifts.operate')
  open(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Body() input: OpenShiftDto,
    @CurrentAccessContext() access: AccessContext,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.service.open(branchId, input, access, key);
  }

  @Post(':shiftId/cash-movements')
  @RequirePermission('shifts.operate')
  addCashMovement(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Param('shiftId', ParseUUIDPipe) shiftId: string,
    @Body() input: CashMovementDto,
    @CurrentAccessContext() access: AccessContext,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.service.addCashMovement(branchId, shiftId, input, access, key);
  }

  @Post(':shiftId/close')
  @RequirePermission('shifts.operate')
  close(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Param('shiftId', ParseUUIDPipe) shiftId: string,
    @Body() input: CloseShiftDto,
    @CurrentAccessContext() access: AccessContext,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.service.close(branchId, shiftId, input, access, key);
  }

  @Post(':shiftId/force-close')
  @RequirePermission('shifts.review')
  forceClose(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Param('shiftId', ParseUUIDPipe) shiftId: string,
    @Body() input: ForceCloseShiftDto,
    @CurrentAccessContext() access: AccessContext,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.service.forceClose(branchId, shiftId, input, access, key);
  }

  @Post(':shiftId/explanation')
  @RequirePermission('shifts.operate')
  explain(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Param('shiftId', ParseUUIDPipe) shiftId: string,
    @Body() input: ShiftExplanationDto,
    @CurrentAccessContext() access: AccessContext,
  ) {
    return this.service.explain(branchId, shiftId, input, access);
  }

  @Post(':shiftId/review')
  @RequirePermission('shifts.review')
  review(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Param('shiftId', ParseUUIDPipe) shiftId: string,
    @Body() input: ReviewShiftDto,
    @CurrentAccessContext() access: AccessContext,
  ) {
    return this.service.review(branchId, shiftId, input, access);
  }
}
