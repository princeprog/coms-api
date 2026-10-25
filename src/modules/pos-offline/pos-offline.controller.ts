import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentAccessContext } from '../../common/decorators/current-access-context.decorator';
import {
  AllowUnassignedRole,
  RequireBranchScope,
  RequirePermission,
} from '../../common/decorators/access-policy.decorator';
import { AuthGatewayGuard } from '../../common/guards/auth-gateway.guard';
import { AuthGuard } from '../../common/guards/auth.guard';
import { AccessControlGuard } from '../../common/guards/access-control.guard';
import type { AccessContext } from '../access-control/access-control.types';
import { offlinePosEnabled } from '../../config/offline-pos.config';
import {
  DeviceDto,
  FinalizeOfflineDto,
  RecoverOfflineDto,
  RecoverFinalizeDto,
  OfflinePageDto,
  RegisterDeviceDto,
  ReviewOfflineDto,
  SyncOfflineDto,
  UpdateDeviceDto,
} from './dto/offline-register.dto';
import { PosOfflineRepository } from './pos-offline.repository';
import { PosOfflineService } from './pos-offline.service';

@Controller('pos-offline')
@UseGuards(AuthGatewayGuard, AuthGuard, AccessControlGuard)
export class PosOfflineContextController {
  @Get('context')
  @AllowUnassignedRole()
  context(@CurrentAccessContext() access: AccessContext) {
    return { user_id: access.userId, enabled: offlinePosEnabled() };
  }
}

@Controller('pos-offline/branches/:branchId')
@UseGuards(AuthGatewayGuard, AuthGuard, AccessControlGuard)
@RequireBranchScope()
export class PosOfflineController {
  constructor(
    private readonly service: PosOfflineService,
    private readonly repository: PosOfflineRepository,
  ) {}
  @Get('devices')
  @RequirePermission('pos_offline.devices_manage')
  devices(@Param('branchId', ParseUUIDPipe) branch: string) {
    return this.repository.devices(branch);
  }
  @Post('devices')
  @RequirePermission('sales.create')
  register(
    @Param('branchId', ParseUUIDPipe) branch: string,
    @CurrentAccessContext() access: AccessContext,
    @Body() input: RegisterDeviceDto,
  ) {
    return this.repository.register(
      branch,
      access.userId,
      input.device_id,
      input.name,
    );
  }
  @Patch('devices/:deviceId')
  @RequirePermission('pos_offline.devices_manage')
  device(
    @Param('branchId', ParseUUIDPipe) branch: string,
    @Param('deviceId', ParseUUIDPipe) id: string,
    @CurrentAccessContext() access: AccessContext,
    @Body() input: UpdateDeviceDto,
  ) {
    return this.repository.updateDevice(branch, access.userId, id, input);
  }
  @Post('sessions/prepare')
  @RequirePermission('sales.create')
  prepare(
    @Param('branchId', ParseUUIDPipe) branch: string,
    @CurrentAccessContext() access: AccessContext,
    @Body() input: DeviceDto,
  ) {
    return this.service.prepare(branch, access.userId, input.device_id);
  }
  @Post('sessions/:sessionId/refresh')
  @RequirePermission('sales.create')
  refresh(
    @Param('branchId', ParseUUIDPipe) branch: string,
    @Param('sessionId', ParseUUIDPipe) id: string,
    @CurrentAccessContext() access: AccessContext,
    @Body() input: DeviceDto,
  ) {
    return this.repository.refresh(branch, access.userId, id, input.device_id);
  }
  @Post('sessions/:sessionId/sync')
  @RequirePermission('sales.create')
  sync(
    @Param('branchId', ParseUUIDPipe) branch: string,
    @Param('sessionId', ParseUUIDPipe) id: string,
    @CurrentAccessContext() access: AccessContext,
    @Body() input: SyncOfflineDto,
  ) {
    return this.service.sync(branch, access.userId, id, input);
  }
  @Post('sessions/:sessionId/finalize')
  @RequirePermission('sales.create')
  finalize(
    @Param('branchId', ParseUUIDPipe) branch: string,
    @Param('sessionId', ParseUUIDPipe) id: string,
    @CurrentAccessContext() access: AccessContext,
    @Body() input: FinalizeOfflineDto,
  ) {
    return this.repository.finalize(
      branch,
      access.userId,
      id,
      input.device_id,
      input.final_sequence,
    );
  }
  @Post('sessions/:sessionId/recover-finalize')
  @RequirePermission('pos_offline.review')
  recoverFinalize(
    @Param('branchId', ParseUUIDPipe) branch: string,
    @Param('sessionId', ParseUUIDPipe) id: string,
    @CurrentAccessContext() access: AccessContext,
    @Body() input: RecoverFinalizeDto,
  ) {
    return this.repository.finalize(
      branch,
      access.userId,
      id,
      input.device_id,
      input.final_sequence,
      { transactionIds: input.transaction_ids, reason: input.reason },
    );
  }
  @Get('sessions')
  @RequirePermission('pos_offline.review')
  sessions(
    @Param('branchId', ParseUUIDPipe) branch: string,
    @Query() query: OfflinePageDto,
  ) {
    return this.repository.sessions(branch, query);
  }
  @Get('sessions/:sessionId/transactions')
  @RequirePermission('pos_offline.review')
  transactions(
    @Param('branchId', ParseUUIDPipe) branch: string,
    @Param('sessionId', ParseUUIDPipe) id: string,
    @Query() query: OfflinePageDto,
  ) {
    return this.repository.transactions(branch, id, query);
  }
  @Post('sessions/:sessionId/review')
  @RequirePermission('pos_offline.review')
  review(
    @Param('branchId', ParseUUIDPipe) branch: string,
    @Param('sessionId', ParseUUIDPipe) id: string,
    @CurrentAccessContext() access: AccessContext,
    @Body() input: ReviewOfflineDto,
  ) {
    return this.repository.review(
      branch,
      access.userId,
      id,
      input.transaction_id,
      input.reason,
    );
  }
  @Post('sessions/:sessionId/recover')
  @RequirePermission('pos_offline.review')
  recover(
    @Param('branchId', ParseUUIDPipe) branch: string,
    @Param('sessionId', ParseUUIDPipe) id: string,
    @CurrentAccessContext() access: AccessContext,
    @Body() input: RecoverOfflineDto,
  ) {
    return this.service.sync(branch, access.userId, id, input, input.reason);
  }
}
