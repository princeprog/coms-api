import { IsDefined, IsString, Matches, ValidateIf } from 'class-validator';

export class AssignStaffRoleDto {
  @ValidateIf((_object, value: unknown) => value !== null)
  @IsDefined()
  @IsString()
  @Matches(/^[1-9]\d{0,18}$/)
  role_id!: string | null;
}
