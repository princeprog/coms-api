import { IsIn, IsOptional, IsUUID, Matches } from 'class-validator';
import type { ReportPeriod } from '../sales-report-period';

export class SalesReportQueryDto {
  @IsOptional()
  @IsIn(['day', 'week', 'month'])
  period?: ReportPeriod;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  date?: string;

  @IsOptional()
  @IsUUID()
  branch_id?: string;
}
