import {
  ArrayUnique,
  IsArray,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateRoleDto {
  @IsString()
  @Matches(/^[A-Z][A-Z0-9_]{1,49}$/)
  code!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(120)
  role_name!: string;

  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  permission_keys!: string[];
}
