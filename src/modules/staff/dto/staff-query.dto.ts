import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class StaffQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsUUID('4')
  branch_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;

  @IsOptional()
  @IsIn(['active', 'inactive', 'unassigned'])
  status?: 'active' | 'inactive' | 'unassigned';
}
