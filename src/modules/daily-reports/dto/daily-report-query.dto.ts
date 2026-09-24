import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

export type DailyReportStatus = 'DRAFT' | 'SUBMITTED' | 'RETURNED' | 'APPROVED';

export class DailyReportQueryDto {
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
  @IsIn(['DRAFT', 'SUBMITTED', 'RETURNED', 'APPROVED'])
  status?: DailyReportStatus;
}
