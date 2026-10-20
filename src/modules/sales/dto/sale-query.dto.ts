import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import {
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { Transform } from 'class-transformer';

export class SaleQueryDto extends PaginationQueryDto {
  override page_size = 10;

  @IsOptional()
  @IsIn(['COMPLETED', 'VOIDED'])
  status?: 'COMPLETED' | 'VOIDED';

  @IsOptional()
  @IsString()
  @MaxLength(40)
  tender_method?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @IsDateString({ strict: true })
  date_from?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @IsDateString({ strict: true })
  date_to?: string;
}
