import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { Transform } from 'class-transformer';
import { parseBooleanFilter } from '../../../common/utils/list-filters';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class InventoryQueryDto extends PaginationQueryDto {
  override page_size = 10;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(120)
  search?: string;

  @IsOptional()
  @Transform(({ value }) => parseBooleanFilter(value))
  @IsBoolean()
  is_active?: boolean;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(80)
  category?: string;
}
