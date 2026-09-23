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
import type { AccessContext } from '../access-control/access-control.types';
import { AccessControlGuard } from '../../common/guards/access-control.guard';
import { AuthGatewayGuard } from '../../common/guards/auth-gateway.guard';
import { AuthGuard } from '../../common/guards/auth.guard';
import { CreateSaleDto } from './dto/create-sale.dto';
import { SaleQueryDto } from './dto/sale-query.dto';
import { VoidSaleDto } from './dto/void-sale.dto';
import { SalesService } from './sales.service';

@Controller('branches/:branchId/sales')
@UseGuards(AuthGatewayGuard, AuthGuard, AccessControlGuard)
@RequireBranchScope()
export class SalesController {
  constructor(private readonly service: SalesService) {}

  @Get()
  @RequirePermission('sales.read')
  list(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Query() query: SaleQueryDto,
  ) {
    return this.service.list(branchId, query);
  }

  @Get(':saleId')
  @RequirePermission('sales.read')
  get(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Param('saleId', ParseUUIDPipe) saleId: string,
  ) {
    return this.service.get(branchId, saleId);
  }

  @Post()
  @RequirePermission('sales.create')
  create(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Body() input: CreateSaleDto,
    @CurrentAccessContext() access: AccessContext,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    return this.service.create(branchId, input, access.userId, idempotencyKey);
  }

  @Post(':saleId/void')
  @RequirePermission('sales.void')
  void(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Param('saleId', ParseUUIDPipe) saleId: string,
    @Body() input: VoidSaleDto,
    @CurrentAccessContext() access: AccessContext,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    return this.service.void(
      branchId,
      saleId,
      input,
      access.userId,
      idempotencyKey,
    );
  }
}
