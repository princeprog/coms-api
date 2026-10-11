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
  RequirePermission,
  RequireSuperAdmin,
} from '../../common/decorators/access-policy.decorator';
import { CurrentAccessContext } from '../../common/decorators/current-access-context.decorator';
import type { AccessContext } from '../access-control/access-control.types';
import { AccessControlGuard } from '../../common/guards/access-control.guard';
import { AuthGatewayGuard } from '../../common/guards/auth-gateway.guard';
import { AuthGuard } from '../../common/guards/auth.guard';
import { CreateProductDto } from './dto/create-product.dto';
import { ProductQueryDto } from './dto/product-query.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { ProductsService } from './products.service';

@Controller('products')
@UseGuards(AuthGatewayGuard, AuthGuard, AccessControlGuard)
export class ProductsController {
  constructor(private readonly service: ProductsService) {}

  @Get()
  @RequirePermission('products.read')
  list(@Query() query: ProductQueryDto) {
    return this.service.list(query);
  }

  @Get(':id')
  @RequirePermission('products.read')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(id);
  }

  @Post()
  @RequireSuperAdmin()
  @RequirePermission('products.create')
  create(
    @Body() dto: CreateProductDto,
    @CurrentAccessContext() access: AccessContext,
  ) {
    return this.service.create(dto, access);
  }

  @Patch(':id')
  @RequireSuperAdmin()
  @RequirePermission('products.update')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProductDto,
    @CurrentAccessContext() access: AccessContext,
  ) {
    return this.service.update(id, dto, access);
  }

  @Post(':id/deactivate')
  @RequireSuperAdmin()
  @RequirePermission('products.deactivate')
  deactivate(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.deactivate(id);
  }
}
