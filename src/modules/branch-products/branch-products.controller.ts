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
  RequireSuperAdmin,
} from '../../common/decorators/access-policy.decorator';
import { AccessControlGuard } from '../../common/guards/access-control.guard';
import { AuthGatewayGuard } from '../../common/guards/auth-gateway.guard';
import { AuthGuard } from '../../common/guards/auth.guard';
import { BranchProductCategoryQueryDto } from './dto/branch-product-category-query.dto';
import { BranchProductQueryDto } from './dto/branch-product-query.dto';
import { CreateBranchProductDto } from './dto/create-branch-product.dto';
import { UpdateBranchProductAvailabilityDto } from './dto/update-branch-product-availability.dto';
import { BranchProductsService } from './branch-products.service';
import { OmitType } from '@nestjs/mapped-types';
class OfferingServicesDto extends OmitType(CreateBranchProductDto, [
  'product_id',
] as const) {}

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

  @Get('categories')
  @RequirePermission('branch_products.read')
  categories(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Query() query: BranchProductCategoryQueryDto,
  ) {
    return this.service.categories(branchId, query.service_type);
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
  @RequireSuperAdmin()
  @RequirePermission('branch_products.create')
  create(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Body() input: CreateBranchProductDto,
  ) {
    return this.service.create(branchId, input);
  }

  @Patch(':productId/services')
  @RequireSuperAdmin()
  @RequirePermission('branch_products.services_update')
  updateServices(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body() input: OfferingServicesDto,
  ) {
    return this.service.updateServices(
      branchId,
      productId,
      input.service_types,
    );
  }

  @Post(':productId/availability')
  @RequireSuperAdmin()
  @RequirePermission('branch_products.availability_update')
  updateAvailability(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body() input: UpdateBranchProductAvailabilityDto,
  ) {
    return this.service.updateAvailability(branchId, productId, input);
  }
}
