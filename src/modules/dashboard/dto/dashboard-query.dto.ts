import { IsOptional, IsUUID, Matches } from 'class-validator';

export class DashboardQueryDto {
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to?: string;
}

export class DashboardOverviewQueryDto extends DashboardQueryDto {
  @IsOptional()
  @IsUUID()
  branch_id?: string;
}
