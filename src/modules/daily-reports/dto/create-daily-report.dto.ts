import { IsString, Matches, MaxLength } from 'class-validator';

export class CreateDailyReportDto {
  @IsString()
  @MaxLength(10)
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  business_date!: string;
}
