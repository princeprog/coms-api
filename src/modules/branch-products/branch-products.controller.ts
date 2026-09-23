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
import {
  RequireBranchScope,
  RequirePermission,
} from '../../common/decorators/access-policy.decorator';
import { AccessControlGuard } from '../../common/guards/access-control.guard';
import { AuthGatewayGuard } from '../../common/guards/auth-gateway.guard';
import { AuthGuard } from '../../common/guards/auth.guard';
import { BranchProductQueryDto } from './dto/branch-product-query.dto';
import { CreateBranchProductDto } from './dto/create-branch-product.dto';
import { UpdateBranchProductAvailabilityDto } from './dto/update-branch-product-availability.dto';
import { UpdateBranchProductPriceDto } from './dto/update-branch-product-price.dto';
import { BranchProductsService } from './branch-products.service';

@Controller('branches/:branchId/products')
@UseGuards(AuthGatewayGuard, AuthGuard, AccessControlGuard)
@RequireBranchScope()
export class BranchProductsController {
  constructor(private readonly service: BranchProductsService) {}

  @Get()
  @RequirePermission('branch_products.read')
  list(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Query() query: BranchProductQueryDto,
  ) {
    return this.service.list(branchId, query);
  }

  @Get(':productId')
  @RequirePermission('branch_products.read')
  get(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Param('productId', ParseUUIDPipe) productId: string,
  ) {
    return this.service.get(branchId, productId);
  }

  @Post()
  @RequirePermission('branch_products.create')
  create(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Body() input: CreateBranchProductDto,
  ) {
    return this.service.create(branchId, input);
  }

  @Patch(':productId')
  @RequirePermission('branch_products.update')
  updatePrice(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body() input: UpdateBranchProductPriceDto,
  ) {
    return this.service.updatePrice(branchId, productId, input);
  }

  @Post(':productId/availability')
  @RequirePermission('branch_products.availability_update')
  updateAvailability(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body() input: UpdateBranchProductAvailabilityDto,
  ) {
    return this.service.updateAvailability(branchId, productId, input);
  }
}
