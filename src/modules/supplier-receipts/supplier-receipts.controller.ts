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
import type { AccessContext } from '../access-control/access-control.types';
import { AccessControlGuard } from '../../common/guards/access-control.guard';
import { AuthGatewayGuard } from '../../common/guards/auth-gateway.guard';
import { AuthGuard } from '../../common/guards/auth.guard';
import { CreateSupplierReceiptDto } from './dto/create-supplier-receipt.dto';
import { SupplierReceiptQueryDto } from './dto/supplier-receipt-query.dto';
import { SupplierReceiptsService } from './supplier-receipts.service';

@Controller('supplier-receipts')
@UseGuards(AuthGatewayGuard, AuthGuard, AccessControlGuard)
export class SupplierReceiptsController {
  constructor(private readonly service: SupplierReceiptsService) {}

  @Get()
  @RequirePermission('supplier_receipts.read')
  list(@Query() query: SupplierReceiptQueryDto) {
    return this.service.list(query);
  }

  @Get(':id')
  @RequirePermission('supplier_receipts.read')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(id);
  }

  @Post()
  @RequirePermission('supplier_receipts.create')
  create(
    @Body() dto: CreateSupplierReceiptDto,
    @CurrentAccessContext() access: AccessContext,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    return this.service.create(dto, access.userId, idempotencyKey);
  }

  @Post(':id/post')
  @RequirePermission('supplier_receipts.post')
  post(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAccessContext() access: AccessContext,
  ) {
    return this.service.post(id, access.userId);
  }
}
