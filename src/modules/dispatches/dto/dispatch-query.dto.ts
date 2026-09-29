import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { IsIn, IsOptional, IsUUID } from 'class-validator';

export class DispatchQueryDto extends PaginationQueryDto {
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
