import { IsString, MaxLength, MinLength } from 'class-validator';

export class UpdateRoleDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  role_name!: string;
}
