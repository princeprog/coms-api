import {
  IsEmail,
  IsString,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

export class UpdateStaffDto {
  @ValidateIf((_object, value) => value !== undefined)
  @IsEmail()
  @MaxLength(320)
  email?: string;

  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  full_name?: string;

  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @MinLength(7)
  @MaxLength(30)
  contact_number?: string;
}
