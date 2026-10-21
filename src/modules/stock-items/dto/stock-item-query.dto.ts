import { parseBooleanFilter } from '../../../common/utils/list-filters';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import {
  STOCK_RECIPE_USES,
  type StockRecipeUse,
} from './create-stock-item.dto';

export class StockItemQueryDto extends PaginationQueryDto {
  override page_size = 10;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @Transform(({ value }) => parseBooleanFilter(value))
  @IsBoolean()
  is_active?: boolean;

  @IsOptional()
  @IsIn(STOCK_RECIPE_USES)
  recipe_use?: StockRecipeUse;
}
