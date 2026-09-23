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
import { CloseDispatchShortageDto } from './dto/close-dispatch-shortage.dto';
import { CreateDispatchDto } from './dto/create-dispatch.dto';
import { DispatchQueryDto } from './dto/dispatch-query.dto';
import { ReceiveDispatchDto } from './dto/receive-dispatch.dto';
import { DispatchesService } from './dispatches.service';

@Controller('dispatches')
@UseGuards(AuthGatewayGuard, AuthGuard, AccessControlGuard)
@RequireBranchScope()
export class DispatchesController {
  constructor(private readonly service: DispatchesService) {}

  @Get()
  @RequirePermission('dispatches.read')
  list(
    @Query() query: DispatchQueryDto,
    @CurrentAccessContext() access: AccessContext,
  ) {
    return this.service.list(query, access);
  }

  @Get(':id')
  @RequirePermission('dispatches.read')
  get(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAccessContext() access: AccessContext,
  ) {
    return this.service.get(id, access);
  }

  @Post()
  @RequirePermission('dispatches.create')
  create(
    @Body() dto: CreateDispatchDto,
    @CurrentAccessContext() access: AccessContext,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    return this.service.create(dto, access, idempotencyKey);
  }

  @Post(':id/dispatch')
  @RequirePermission('dispatches.dispatch')
  dispatch(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAccessContext() access: AccessContext,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    return this.service.dispatch(id, access, idempotencyKey);
  }

  @Post(':id/receive')
  @RequirePermission('dispatches.receive')
  receive(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReceiveDispatchDto,
    @CurrentAccessContext() access: AccessContext,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    return this.service.receive(id, dto, access, idempotencyKey);
  }

  @Post(':id/shortage-closures')
  @RequirePermission('dispatches.shortage_close')
  closeShortage(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CloseDispatchShortageDto,
    @CurrentAccessContext() access: AccessContext,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    return this.service.closeShortage(id, dto, access, idempotencyKey);
  }
}
