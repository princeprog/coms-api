import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

export class DispatchQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  page_size = 25;

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
}
