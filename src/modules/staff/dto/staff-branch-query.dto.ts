import { IsOptional, IsUUID } from 'class-validator';

export class StaffBranchQueryDto {
  @IsOptional()
  @IsUUID('4')
  branch_id?: string;
}
