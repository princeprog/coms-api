import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { RequirePermission } from '../../common/decorators/access-policy.decorator';
import { AccessControlGuard } from '../../common/guards/access-control.guard';
import { AuthGatewayGuard } from '../../common/guards/auth-gateway.guard';
import { AuthGuard } from '../../common/guards/auth.guard';
import { ReplaceRecipeDto } from './dto/replace-recipe.dto';
import { RecipesService } from './recipes.service';

@Controller('products/:productId/recipe')
@UseGuards(AuthGatewayGuard, AuthGuard, AccessControlGuard)
export class RecipesController {
  constructor(private readonly service: RecipesService) {}

  @Get()
  @RequirePermission('recipes.read')
  get(@Param('productId', ParseUUIDPipe) productId: string) {
    return this.service.get(productId);
  }

  @Post()
  @RequirePermission('recipes.create')
  create(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body() input: ReplaceRecipeDto,
  ) {
    return this.service.create(productId, input);
  }

  @Put()
  @RequirePermission('recipes.update')
  update(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body() input: ReplaceRecipeDto,
  ) {
    return this.service.update(productId, input);
  }
}
