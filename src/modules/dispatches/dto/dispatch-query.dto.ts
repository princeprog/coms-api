import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { IsIn, IsOptional, IsUUID, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';

export class DispatchQueryDto extends PaginationQueryDto {
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @IsIn(['newest', 'oldest', 'branch_asc', 'branch_desc'])
  sort?: 'newest' | 'oldest' | 'branch_asc' | 'branch_desc';

  @IsOptional()
  @IsUUID()
  branch_id?: string;

  @IsOptional()
  @IsIn([
    'DRAFT',
    'IN_TRANSIT',
    'PARTIALLY_RECEIVED',
    'RECEIVED',
    'CLOSED_WITH_SHORTAGE',
  ])
  status?:
    | 'DRAFT'
    | 'IN_TRANSIT'
    | 'PARTIALLY_RECEIVED'
    | 'RECEIVED'
    | 'CLOSED_WITH_SHORTAGE';

  @IsOptional()
  @IsIn(['OPEN', 'RECOUNT_REQUESTED', 'RESOLVED', 'NONE'])
  discrepancy_status?: 'OPEN' | 'RECOUNT_REQUESTED' | 'RESOLVED' | 'NONE';
}
