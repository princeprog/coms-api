import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { RequirePermission } from '../../common/decorators/access-policy.decorator';
import { CurrentAccessContext } from '../../common/decorators/current-access-context.decorator';
import { AccessControlGuard } from '../../common/guards/access-control.guard';
import { AuthGatewayGuard } from '../../common/guards/auth-gateway.guard';
import { AuthGuard } from '../../common/guards/auth.guard';
import type { AccessContext } from '../access-control/access-control.types';
import { CostsExportService } from './costs-export.service';
import { CostsService } from './costs.service';
import {
  CostRangeQueryDto,
  ProductCostQueryDto,
  SetStockCostDto,
  StockCostQueryDto,
} from './dto/cost-query.dto';

@Controller('costs')
@UseGuards(AuthGatewayGuard, AuthGuard, AccessControlGuard)
export class CostsController {
  constructor(
    private readonly service: CostsService,
    private readonly exports: CostsExportService,
  ) {}

  @Get('products/export')
  @RequirePermission('costs.read')
  exportProducts(@Query() query: ProductCostQueryDto) {
    return this.exports.productCosts(query);
  }

  @Get('branches/export')
  @RequirePermission('costs.read')
  exportBranches(
    @Query() query: CostRangeQueryDto,
    @CurrentAccessContext() access: AccessContext,
  ) {
    return this.exports.branchProfit(query, access);
  }

  @Get('branch-products/export')
  @RequirePermission('costs.read')
  exportBranchProducts(
    @Query() query: CostRangeQueryDto,
    @CurrentAccessContext() access: AccessContext,
  ) {
    return this.exports.productProfit(query, access);
  }

  @Get('stock-items/export')
  @RequirePermission('costs.read')
  exportStockItems(@Query() query: StockCostQueryDto) {
    return this.exports.stockCosts(query);
  }

  @Get('products')
  @RequirePermission('costs.read')
  products(@Query() query: ProductCostQueryDto) {
    return this.service.productCosts(query);
  }

  @Get('branches')
  @RequirePermission('costs.read')
  branches(
    @Query() query: CostRangeQueryDto,
    @CurrentAccessContext() access: AccessContext,
  ) {
    return this.service.branchProfit(query, access);
  }

  @Get('branch-products')
  @RequirePermission('costs.read')
  branchProducts(
    @Query() query: CostRangeQueryDto,
    @CurrentAccessContext() access: AccessContext,
  ) {
    return this.service.branchProductProfit(query, access);
  }

  @Get('stock-items')
  @RequirePermission('costs.read')
  stockItems(@Query() query: StockCostQueryDto) {
    return this.service.stockCosts(query);
  }

  @Put('stock-items/:id')
  @RequirePermission('costs.manage')
  setStockCost(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: SetStockCostDto,
    @CurrentAccessContext() access: AccessContext,
  ) {
    return this.service.setStockCost(id, input, access);
  }
}
