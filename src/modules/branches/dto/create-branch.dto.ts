import {
  IsBoolean,
  IsDateString,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateBranchDto {
  @IsString()
  @Matches(/^[A-Z0-9][A-Z0-9_-]{1,49}$/)
  code!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(160)
  branch_name!: string;

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
