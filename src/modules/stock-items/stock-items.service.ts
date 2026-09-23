import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CreateStockItemDto } from './dto/create-stock-item.dto';
import { StockItemQueryDto } from './dto/stock-item-query.dto';
import { UpdateStockItemDto } from './dto/update-stock-item.dto';
import { StockItemsRepository } from './stock-items.repository';

@Injectable()
export class StockItemsService {
  constructor(private readonly repository: StockItemsRepository) {}

  list(query: StockItemQueryDto) {
    const search = query.search?.trim();
    return this.repository.list({
      page: query.page,
      page_size: query.page_size,
      ...(search ? { search } : {}),
      ...(query.is_active === undefined ? {} : { is_active: query.is_active }),
    });
  }

  async get(id: string) {
    const stockItem = await this.repository.findById(id);
    if (!stockItem) throw new NotFoundException('Stock item not found');
    return stockItem;
  }

  create(input: CreateStockItemDto) {
    const stockItemName = input.stock_item_name.trim();
    const category = input.category.trim();
    const unit = input.unit.trim();
    if (stockItemName.length < 2 || !category || !unit)
      throw new BadRequestException(
        'Stock item name, category, and unit are required',
      );
    return this.repository.create({
      stock_item_name: stockItemName,
      category,
      unit,
    });
  }

  async update(id: string, input: UpdateStockItemDto) {
    const patch: Parameters<StockItemsRepository['update']>[1] = {
      ...(input.stock_item_name !== undefined
        ? { stock_item_name: input.stock_item_name.trim() }
        : {}),
      ...(input.category !== undefined
        ? { category: input.category.trim() }
        : {}),
      ...(input.unit !== undefined ? { unit: input.unit.trim() } : {}),
    };

    if (Object.keys(patch).length === 0)
      throw new BadRequestException(
        'At least one stock item field is required',
      );
    if (patch.stock_item_name !== undefined && patch.stock_item_name.length < 2)
      throw new BadRequestException(
        'Stock item name must contain at least 2 characters',
      );
    if (
      (patch.category !== undefined && !patch.category) ||
      (patch.unit !== undefined && !patch.unit)
    )
      throw new BadRequestException('Category and unit cannot be empty');

    return this.repository.update(id, patch);
  }

  deactivate(id: string) {
    return this.repository.deactivate(id);
  }
}
