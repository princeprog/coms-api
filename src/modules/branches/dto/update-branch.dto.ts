import {
  IsBoolean,
  IsDateString,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class UpdateBranchDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  branch_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  address?: string | null;

  @IsOptional()
  @IsDateString()
  date_opened?: string | null;

  @IsOptional()
  @IsBoolean()
  has_dine_in?: boolean;
}
