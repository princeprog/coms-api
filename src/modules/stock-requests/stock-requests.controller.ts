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
import { RequirePermission } from '../../common/decorators/access-policy.decorator';
import { AccessControlGuard } from '../../common/guards/access-control.guard';
import { AuthGatewayGuard } from '../../common/guards/auth-gateway.guard';
import { AuthGuard } from '../../common/guards/auth.guard';
import type { AccessContext } from '../access-control/access-control.types';
import { CreateStockRequestDto } from './dto/create-stock-request.dto';
import { StockRequestQueryDto } from './dto/stock-request-query.dto';
import { StockRequestsService } from './stock-requests.service';

@Controller('stock-requests')
@UseGuards(AuthGatewayGuard, AuthGuard, AccessControlGuard)
export class StockRequestsController {
  constructor(private readonly service: StockRequestsService) {}

  @Get()
  @RequirePermission('stock_requests.read')
  list(
    @Query() query: StockRequestQueryDto,
    @CurrentAccessContext() access: AccessContext,
  ) {
    return this.service.list(query, access);
  }

  @Get(':id')
  @RequirePermission('stock_requests.read')
  get(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAccessContext() access: AccessContext,
  ) {
    return this.service.get(id, access);
  }

  @Post()
  @RequirePermission('stock_requests.create')
  create(
    @Body() dto: CreateStockRequestDto,
    @CurrentAccessContext() access: AccessContext,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    return this.service.create(dto, access, idempotencyKey);
  }

  @Post(':id/approve')
  @RequirePermission('stock_requests.approve')
  approve(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAccessContext() access: AccessContext,
  ) {
    return this.service.approve(id, access);
  }

  @Post(':id/reject')
  @RequirePermission('stock_requests.reject')
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAccessContext() access: AccessContext,
  ) {
    return this.service.reject(id, access);
  }

  @Post(':id/cancel')
  @RequirePermission('stock_requests.cancel')
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAccessContext() access: AccessContext,
  ) {
    return this.service.cancel(id, access);
  }
}
