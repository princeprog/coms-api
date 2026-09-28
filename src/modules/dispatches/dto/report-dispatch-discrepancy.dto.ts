import { IsString, Matches, MaxLength } from 'class-validator';

export class ReportDispatchDiscrepancyDto {
  @IsString()
  @MaxLength(500)
  @Matches(/\S/)
  note!: string;
}
