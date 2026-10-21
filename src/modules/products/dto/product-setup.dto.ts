import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDefined,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { CreateProductDto } from './create-product.dto';

export const RECIPE_USAGE_SCOPES = ['ALL', 'DINE_IN', 'TAKEAWAY'] as const;
export type RecipeUsageScope = (typeof RECIPE_USAGE_SCOPES)[number];

export class RecipeLineDto {
  @IsUUID()
  stock_item_id!: string;
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(24)
  @Matches(/^\d+(?:\.\d{1,4})?$/, {
    message: 'Enter a recipe quantity with at most 4 decimal places',
  })
  quantity!: string;
  @IsIn(RECIPE_USAGE_SCOPES)
  usage_scope!: RecipeUsageScope;
}

export class ProductSetupDto {
  @Type(() => Number)
  @IsInt()
  @Min(0)
  expected_product_revision!: number;
  @IsDefined()
  @ValidateNested()
  @Type(() => CreateProductDto)
  product!: CreateProductDto;
  // Omitted keeps the saved recipe; an array (including []) replaces it.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => RecipeLineDto)
  recipe?: RecipeLineDto[];
}
