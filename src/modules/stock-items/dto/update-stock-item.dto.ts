import { Transform } from 'class-transformer';
import {
  IsIn,
  IsBoolean,
  IsString,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import {
  STOCK_RECIPE_USES,
  type StockRecipeUse,
} from './create-stock-item.dto';

const trimText = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class UpdateStockItemDto {
  @ValidateIf((_object, value) => value !== undefined)
  @Transform(trimText)
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  stock_item_name?: string;

  @ValidateIf((_object, value) => value !== undefined)
  @Transform(trimText)
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  category?: string;

  @ValidateIf((_object, value) => value !== undefined)
  @Transform(trimText)
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  unit?: string;

  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(STOCK_RECIPE_USES)
  recipe_use?: StockRecipeUse;

  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  daily_count_required?: boolean;
}
