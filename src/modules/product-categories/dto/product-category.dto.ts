import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { parseBooleanFilter } from '../../../common/utils/list-filters';
const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
export class CreateProductCategoryDto {
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name!: string;
}
export class UpdateProductCategoryDto {
  @ValidateIf((_o, v) => v !== undefined)
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name?: string;
  @ValidateIf((_o, v) => v !== undefined)
  @IsBoolean()
  is_active?: boolean;
}
export class AvailableProductCategoryQueryDto extends PaginationQueryDto {
  override page_size = 10;
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  search?: string;
}
export class ProductCategoryQueryDto extends AvailableProductCategoryQueryDto {
  @IsOptional()
  @Transform(({ value }) => parseBooleanFilter(value))
  @IsBoolean()
  is_active?: boolean;
}
