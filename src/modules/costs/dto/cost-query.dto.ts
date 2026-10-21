import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { parseBooleanFilter } from '../../../common/utils/list-filters';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CostRangeQueryDto extends PaginationQueryDto {
  override page_size = 10;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to?: string;

  @IsOptional()
  @IsUUID()
  branch_id?: string;
}

export class ProductCostQueryDto extends PaginationQueryDto {
  override page_size = 10;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @IsIn(['all', 'incomplete'])
  status?: 'all' | 'incomplete';
}

export class StockCostQueryDto extends PaginationQueryDto {
  override page_size = 10;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @Transform(({ value }) => parseBooleanFilter(value))
  @IsBoolean()
  missing_only?: boolean;
}

export class SetStockCostDto {
  @Transform(trim)
  @IsString()
  @MaxLength(24)
  @Matches(/^\d+(?:\.\d{1,4})?$/, {
    message: 'Enter a cost with at most 4 decimal places',
  })
  unit_cost!: string;

  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(300)
  reason!: string;
}
