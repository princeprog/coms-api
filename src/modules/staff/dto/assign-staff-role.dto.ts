import { IsString, Matches } from 'class-validator';

export class AssignStaffRoleDto {
  @IsString()
  @Matches(/^[1-9]\d{0,18}$/)
  role_id!: string;
}
