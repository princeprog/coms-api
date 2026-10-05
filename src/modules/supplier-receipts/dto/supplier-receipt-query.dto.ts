import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';

export class SupplierReceiptQueryDto extends PaginationQueryDto {
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @IsUUID()
  supplier_id?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  received_from?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  received_to?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Matches(/^\d+(?:\.\d+)?$/)
  min_cost?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Matches(/^\d+(?:\.\d+)?$/)
  max_cost?: string;

  @IsOptional()
  @IsIn([
    'newest',
    'oldest',
    'cost_highest',
    'cost_lowest',
    'supplier_asc',
    'supplier_desc',
  ])
  sort?:
    | 'newest'
    | 'oldest'
    | 'cost_highest'
    | 'cost_lowest'
    | 'supplier_asc'
    | 'supplier_desc';
}
