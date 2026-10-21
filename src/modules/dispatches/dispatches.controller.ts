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
  RequirePermission,
  RequireBranchScope,
} from '../../common/decorators/access-policy.decorator';
import { AccessControlGuard } from '../../common/guards/access-control.guard';
import { AuthGatewayGuard } from '../../common/guards/auth-gateway.guard';
import { AuthGuard } from '../../common/guards/auth.guard';
import type { AccessContext } from '../access-control/access-control.types';
import { CloseDispatchShortageDto } from './dto/close-dispatch-shortage.dto';
import {
  CreateDispatchDto,
  SendDispatchDraftDto,
  SendDispatchDto,
} from './dto/create-dispatch.dto';
import { DispatchQueryDto } from './dto/dispatch-query.dto';
import { ReceiveDispatchDto } from './dto/receive-dispatch.dto';
import { RestockSuggestionQueryDto } from './dto/restock-suggestion-query.dto';
import { DispatchesService } from './dispatches.service';
import { DispatchRestockService } from './dispatch-restock.service';
import { ReviewLateCountDto } from './dto/review-late-count.dto';

@Controller('dispatches')
@UseGuards(AuthGatewayGuard, AuthGuard, AccessControlGuard)
export class DispatchesController {
  constructor(
    private readonly service: DispatchesService,
    private readonly restock: DispatchRestockService,
  ) {}

  @Get()
  @RequirePermission('dispatches.read')
  list(
    @Query() query: DispatchQueryDto,
    @CurrentAccessContext() access: AccessContext,
  ) {
    return this.service.list(query, access);
  }

  // Declared before ':id' so the path is not parsed as a dispatch ID.
  @Get('restock-suggestions')
  @RequirePermission('dispatches.create')
  @RequireBranchScope()
  restockSuggestions(
    @Query() query: RestockSuggestionQueryDto,
    @CurrentAccessContext() access: AccessContext,
  ) {
    return this.restock.suggestions(query.branch_id.toLowerCase(), access);
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

  @Post('send')
  @RequirePermission('dispatches.dispatch')
  @RequireBranchScope()
  send(
    @Body() dto: SendDispatchDto,
    @CurrentAccessContext() access: AccessContext,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    return this.service.send(dto, access, idempotencyKey);
  }

  @Post(':id/dispatch')
  @RequirePermission('dispatches.dispatch')
  dispatch(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SendDispatchDraftDto,
    @CurrentAccessContext() access: AccessContext,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    return this.service.dispatch(id, dto, access, idempotencyKey);
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

  @Post(':id/late-counts/:caseId/review')
  @RequirePermission('dispatches.shortage_close')
  reviewLateCount(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('caseId', ParseUUIDPipe) caseId: string,
    @Body() dto: ReviewLateCountDto,
    @CurrentAccessContext() access: AccessContext,
  ) {
    return this.service.reviewLateCount(
      id,
      caseId,
      dto.action,
      dto.reason,
      access,
    );
  }
}
