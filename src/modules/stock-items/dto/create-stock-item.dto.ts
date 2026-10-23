import { Transform } from 'class-transformer';
import {
  IsIn,
  IsBoolean,
  ValidateIf,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export const STOCK_RECIPE_USES = ['RECIPE', 'OPERATING_SUPPLY'] as const;
export type StockRecipeUse = (typeof STOCK_RECIPE_USES)[number];

const trimText = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateStockItemDto {
  @Transform(trimText)
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  stock_item_name!: string;

  @Transform(trimText)
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  category!: string;

  @Transform(trimText)
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  unit!: string;

  // Defaults to RECIPE so older clients keep creating recipe-usable stock.
  @IsOptional()
  @IsIn(STOCK_RECIPE_USES)
  recipe_use?: StockRecipeUse;

  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  daily_count_required?: boolean;
}
