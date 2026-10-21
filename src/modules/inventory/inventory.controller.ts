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
import { CreateInventoryAdjustmentDto } from './dto/create-inventory-adjustment.dto';
import { InventoryMovementQueryDto } from './dto/inventory-movement-query.dto';
import { InventoryQueryDto } from './dto/inventory-query.dto';
import { InventoryExportService } from './inventory-export.service';
import { InventoryService } from './inventory.service';

@Controller('inventory')
@UseGuards(AuthGatewayGuard, AuthGuard, AccessControlGuard)
export class InventoryController {
  constructor(
    private readonly service: InventoryService,
    private readonly exports: InventoryExportService,
  ) {}

  @Get('commissary/export')
  @RequirePermission('inventory.commissary_read')
  exportCommissary(@Query() query: InventoryQueryDto) {
    return this.exports.commissaryBalances(query);
  }

  @Get('commissary/movements/export')
  @RequirePermission('inventory.commissary_read')
  exportCommissaryMovements(@Query() query: InventoryMovementQueryDto) {
    return this.exports.commissaryMovements(query);
  }

  @Get('branches/:branchId/export')
  @RequirePermission('inventory.read')
  @RequireBranchScope()
  exportBranch(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Query() query: InventoryQueryDto,
  ) {
    return this.exports.branchBalances(branchId, query);
  }

  @Get('branches/:branchId/movements/export')
  @RequirePermission('inventory.read')
  @RequireBranchScope()
  exportBranchMovements(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Query() query: InventoryMovementQueryDto,
  ) {
    return this.exports.branchMovements(branchId, query);
  }

  @Get('commissary')
  @RequirePermission('inventory.commissary_read')
  listCommissary(@Query() query: InventoryQueryDto) {
    return this.service.listCommissary(query);
  }

  @Get('commissary/movements')
  @RequirePermission('inventory.commissary_read')
  listCommissaryMovements(@Query() query: InventoryMovementQueryDto) {
    return this.service.listCommissaryMovements(query);
  }

  @Post('commissary/adjustments')
  @RequirePermission('inventory.commissary_adjust')
  adjustCommissary(
    @Body() dto: CreateInventoryAdjustmentDto,
    @CurrentAccessContext() access: AccessContext,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    return this.service.adjustCommissary(dto, access.userId, idempotencyKey);
  }

  @Get('branches/:branchId')
  @RequirePermission('inventory.read')
  @RequireBranchScope()
  listBranch(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Query() query: InventoryQueryDto,
  ) {
    return this.service.listBranch(branchId, query);
  }

  @Get('branches/:branchId/movements')
  @RequirePermission('inventory.read')
  @RequireBranchScope()
  listBranchMovements(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Query() query: InventoryMovementQueryDto,
  ) {
    return this.service.listBranchMovements(branchId, query);
  }

  @Post('branches/:branchId/adjustments')
  @RequirePermission('inventory.adjust')
  @RequireBranchScope()
  adjustBranch(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Body() dto: CreateInventoryAdjustmentDto,
    @CurrentAccessContext() access: AccessContext,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    return this.service.adjustBranch(
      branchId,
      dto,
      access.userId,
      idempotencyKey,
    );
  }
}
