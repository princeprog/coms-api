import { IsString, MinLength, MaxLength } from 'class-validator';

export class UpdateDefaultPasswordDto {
  @IsString()
  @MinLength(12)
  @MaxLength(128)
  password!: string;
}
