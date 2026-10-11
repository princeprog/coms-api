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
import { PaymentMethodsService } from './payment-methods.service';
import {
  PaymentMethodQueryDto,
  SavePaymentMethodDto,
} from './dto/payment-method.dto';

@Controller('payment-methods')
@UseGuards(AuthGatewayGuard, AuthGuard, AccessControlGuard)
export class PaymentMethodsController {
  constructor(private readonly service: PaymentMethodsService) {}
  @Get('available')
  @RequirePermission('sales.create')
  available() {
    return this.service.available();
  }

  @Get()
  @RequireSuperAdmin()
  list(@Query() query: PaymentMethodQueryDto) {
    return this.service.list(query);
  }

  @Post()
  @RequireSuperAdmin()
  create(@Body() input: SavePaymentMethodDto) {
    return this.service.save(input);
  }

  @Patch(':id')
  @RequireSuperAdmin()
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: SavePaymentMethodDto,
  ) {
    return this.service.save(input, id);
  }

  @Post(':id/deactivate')
  @RequireSuperAdmin()
  deactivate(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.deactivate(id);
  }
}
