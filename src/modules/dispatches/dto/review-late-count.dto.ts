import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
export class ReviewLateCountDto {
  @IsIn(['POST', 'RETURN'])
  action!: 'POST' | 'RETURN';

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
