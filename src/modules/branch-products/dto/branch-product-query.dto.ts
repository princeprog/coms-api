import { parseBooleanFilter } from '../../../common/utils/list-filters';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsUUID,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class BranchProductQueryDto extends PaginationQueryDto {
  override page_size = 10;

  @IsOptional()
  @IsUUID()
  category_id?: string;

  @IsOptional() @IsIn(['DINE_IN', 'TAKEAWAY']) service_type?:
    'DINE_IN' | 'TAKEAWAY';
  @IsOptional()
  @Transform(({ value }) => parseBooleanFilter(value))
  @IsBoolean()
  eligible_only?: boolean;
  @IsIn(['product_name', 'price', 'created_at']) sort_by:
    'product_name' | 'price' | 'created_at' = 'product_name';
  @IsIn(['asc', 'desc']) sort_order: 'asc' | 'desc' = 'asc';
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @Transform(({ value }) => parseBooleanFilter(value))
  @IsBoolean()
  is_available?: boolean;
}
