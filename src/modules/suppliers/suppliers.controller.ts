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
import { RequirePermission } from '../../common/decorators/access-policy.decorator';
import { AccessControlGuard } from '../../common/guards/access-control.guard';
import { AuthGatewayGuard } from '../../common/guards/auth-gateway.guard';
import { AuthGuard } from '../../common/guards/auth.guard';
import { CreateSupplierDto } from './dto/create-supplier.dto';
import { SupplierQueryDto } from './dto/supplier-query.dto';
import { UpdateSupplierDto } from './dto/update-supplier.dto';
import { SuppliersService } from './suppliers.service';

@Controller('suppliers')
@UseGuards(AuthGatewayGuard, AuthGuard, AccessControlGuard)
export class SuppliersController {
  constructor(private readonly service: SuppliersService) {}

  @Get()
  @RequirePermission('suppliers.read')
  list(@Query() query: SupplierQueryDto) {
    return this.service.list(query);
  }

  @Get(':id')
  @RequirePermission('suppliers.read')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(id);
  }

  @Post()
  @RequirePermission('suppliers.create')
  create(@Body() dto: CreateSupplierDto) {
    return this.service.create(dto);
  }

  @Patch(':id')
  @RequirePermission('suppliers.update')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSupplierDto,
  ) {
    return this.service.update(id, dto);
  }

  @Post(':id/deactivate')
  @RequirePermission('suppliers.deactivate')
  deactivate(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.deactivate(id);
  }
}
