import { parseBooleanFilter } from '../../../common/utils/list-filters';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class SupplierQueryDto extends PaginationQueryDto {
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @Transform(({ value }) => parseBooleanFilter(value))
  @IsBoolean()
  is_active?: boolean;
}
