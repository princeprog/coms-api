import { IsIn, IsOptional } from 'class-validator';
export class BranchProductCategoryQueryDto {
  @IsOptional()
  @IsIn(['DINE_IN', 'TAKEAWAY'])
  service_type?: 'DINE_IN' | 'TAKEAWAY';
}
