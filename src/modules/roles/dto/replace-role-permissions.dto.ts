import { ArrayUnique, IsArray, IsString } from 'class-validator';

export class ReplaceRolePermissionsDto {
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  permission_keys!: string[];
}
