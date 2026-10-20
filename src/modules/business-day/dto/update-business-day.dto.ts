import { Matches } from 'class-validator';

export class UpdateBusinessDayDto {
  @Matches(/^(?:[01]\d|2[0-3]):(?:00|30)$/, {
    message: 'Start time must be on the hour or half hour (HH:00 or HH:30)',
  })
  start_time!: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'Effective date must use YYYY-MM-DD',
  })
  effective_from!: string;
}
