import { IsString, Matches, MaxLength } from 'class-validator';

export class RequestDispatchRecountDto {
  @IsString()
  @MaxLength(500)
  @Matches(/\S/)
  reason!: string;
}
