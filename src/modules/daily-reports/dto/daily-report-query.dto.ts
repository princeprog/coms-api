import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { IsIn, IsOptional } from 'class-validator';

export type DailyReportStatus = 'DRAFT' | 'SUBMITTED' | 'RETURNED' | 'APPROVED';

export class DailyReportQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(['DRAFT', 'SUBMITTED', 'RETURNED', 'APPROVED'])
  status?: DailyReportStatus;
}
