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
import { AccessControlGuard } from '../../common/guards/access-control.guard';
import { AuthGatewayGuard } from '../../common/guards/auth-gateway.guard';
import { AuthGuard } from '../../common/guards/auth.guard';
import { ProductCategoriesService } from './product-categories.service';
import {
  AvailableProductCategoryQueryDto,
  CreateProductCategoryDto,
  ProductCategoryQueryDto,
  UpdateProductCategoryDto,
} from './dto/product-category.dto';
@Controller('product-categories')
@UseGuards(AuthGatewayGuard, AuthGuard, AccessControlGuard)
export class ProductCategoriesController {
  constructor(private readonly service: ProductCategoriesService) {}
  @Get()
  @RequireSuperAdmin()
  list(@Query() query: ProductCategoryQueryDto) {
    return this.service.list(query);
  }
  @Get('available')
  @RequirePermission('products.read')
  available(@Query() query: AvailableProductCategoryQueryDto) {
    return this.service.available(query);
  }
  @Post()
  @RequireSuperAdmin()
  create(@Body() input: CreateProductCategoryDto) {
    return this.service.create(input);
  }
  @Patch(':id')
  @RequireSuperAdmin()
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: UpdateProductCategoryDto,
  ) {
    return this.service.update(id, input);
  }
  @Post(':id/deactivate')
  @RequireSuperAdmin()
  deactivate(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.deactivate(id);
  }
}
