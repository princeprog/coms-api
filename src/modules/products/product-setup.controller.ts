import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  RequirePermission,
  RequireSuperAdmin,
} from '../../common/decorators/access-policy.decorator';
import { CurrentAccessContext } from '../../common/decorators/current-access-context.decorator';
import { AccessControlGuard } from '../../common/guards/access-control.guard';
import { AuthGuard } from '../../common/guards/auth.guard';
import { AuthGatewayGuard } from '../../common/guards/auth-gateway.guard';
import type { AccessContext } from '../access-control/access-control.types';
import { ProductSetupDto } from './dto/product-setup.dto';
import { ProductSetupService } from './product-setup.service';
@Controller('products')
@UseGuards(AuthGatewayGuard, AuthGuard, AccessControlGuard)
export class ProductSetupController {
  constructor(private readonly service: ProductSetupService) {}
  @Get(':id/setup')
  @RequirePermission('products.read')
  get(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAccessContext() access: AccessContext,
  ) {
    return this.service.get(id, access);
  }
  @Post('setup')
  @RequireSuperAdmin()
  @RequirePermission('products.create')
  create(
    @Body() input: ProductSetupDto,
    @CurrentAccessContext() access: AccessContext,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.service.save(undefined, input, access, key);
  }
  @Put(':id/setup')
  @RequireSuperAdmin()
  @RequirePermission('products.read')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: ProductSetupDto,
    @CurrentAccessContext() access: AccessContext,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.service.save(id, input, access, key);
  }
}
