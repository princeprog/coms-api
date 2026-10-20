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
import {
  CreateDirectPurchaseDto,
  DirectPurchaseQueryDto,
} from './dto/direct-purchase.dto';
import { DirectPurchasesService } from './direct-purchases.service';
@Controller('direct-purchases')
@UseGuards(AuthGatewayGuard, AuthGuard, AccessControlGuard)
export class DirectPurchasesController {
  constructor(private readonly service: DirectPurchasesService) {}
  @Get() @RequirePermission('supplier_receipts.read') list(
    @Query() query: DirectPurchaseQueryDto,
  ) {
    return this.service.list(query);
  }
  @Get(':id') @RequirePermission('supplier_receipts.read') get(
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.get(id);
  }
  @Post() @RequirePermission('supplier_receipts.create') create(
    @Body() input: CreateDirectPurchaseDto,
    @CurrentAccessContext() access: AccessContext,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.service.create(input, access.userId, key);
  }
}
