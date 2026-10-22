import {
  IsDateString,
  IsIn,
  IsOptional,
  IsUUID,
  Matches,
} from 'class-validator';
import { DailyReportQueryDto } from './daily-report-query.dto';

export class DailyReportDirectoryQueryDto extends DailyReportQueryDto {
  override page_size = 10;

  @IsOptional()
  @IsUUID()
  branch_id?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @IsDateString({ strict: true })
  date_from?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @IsDateString({ strict: true })
  date_to?: string;

  @IsOptional()
  @IsIn(['newest', 'oldest'])
  sort: 'newest' | 'oldest' = 'newest';
}
