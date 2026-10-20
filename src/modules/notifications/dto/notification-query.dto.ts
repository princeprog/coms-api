import { Type } from 'class-transformer';
import { IsIn, IsInt, Max, Min } from 'class-validator';

export class NotificationQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000000)
  page = 1;
  @Type(() => Number)
  @IsIn([10, 30, 50])
  page_size = 10;
  @IsIn(['all', 'unread'])
  status: 'all' | 'unread' = 'all';
  @IsIn(['all', 'dispatches', 'reports'])
  type: 'all' | 'dispatches' | 'reports' = 'all';
}
