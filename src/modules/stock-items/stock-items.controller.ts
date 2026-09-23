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
import { CreateStockItemDto } from './dto/create-stock-item.dto';
import { StockItemQueryDto } from './dto/stock-item-query.dto';
import { UpdateStockItemDto } from './dto/update-stock-item.dto';
import { StockItemsService } from './stock-items.service';

@Controller('stock-items')
@UseGuards(AuthGatewayGuard, AuthGuard, AccessControlGuard)
export class StockItemsController {
  constructor(private readonly service: StockItemsService) {}

  @Get()
  @RequirePermission('stock_items.read')
  list(@Query() query: StockItemQueryDto) {
    return this.service.list(query);
  }

  @Get(':id')
  @RequirePermission('stock_items.read')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(id);
  }

  @Post()
  @RequirePermission('stock_items.create')
  create(@Body() dto: CreateStockItemDto) {
    return this.service.create(dto);
  }

  @Patch(':id')
  @RequirePermission('stock_items.update')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateStockItemDto,
  ) {
    return this.service.update(id, dto);
  }

  @Post(':id/deactivate')
  @RequirePermission('stock_items.deactivate')
  deactivate(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.deactivate(id);
  }
}
