import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class BranchQueryDto extends PaginationQueryDto {
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @IsIn(['active', 'inactive'])
  status?: 'active' | 'inactive';

  @IsOptional()
  @IsIn(['DINE_IN', 'TAKEAWAY'])
  service_type?: 'DINE_IN' | 'TAKEAWAY';

  @IsOptional()
  @IsIn(['branch_name', 'date_opened'])
  sort_by?: 'branch_name' | 'date_opened';

  @IsOptional()
  @IsIn(['asc', 'desc'])
  sort_order?: 'asc' | 'desc';
}
