import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  PERMISSION_CATALOG,
  type PermissionKey,
} from '../access-control/permission-catalog';
import { RolesRepository } from './roles.repository';

const PERMISSION_KEYS = new Set<string>(
  PERMISSION_CATALOG.map(
    ({ module_key, action_key }) => `${module_key}.${action_key}`,
  ),
);
const ROLE_ID_PATTERN = /^[1-9]\d*$/;

@Injectable()
export class RolesService {
  constructor(private readonly repository: RolesRepository) {}

  list() {
    return this.repository.list();
  }

  listPermissions() {
    return PERMISSION_CATALOG.map((permission) => ({
      ...permission,
      key: `${permission.module_key}.${permission.action_key}`,
    }));
  }

  create(input: {
    code: string;
    role_name: string;
    permission_keys: string[];
  }) {
    const roleName = input.role_name.trim();
    if (roleName.length < 2)
      throw new BadRequestException(
        'Role name must contain at least 2 characters',
      );
    const permissionKeys = this.validatePermissionKeys(input.permission_keys);
    return this.repository.create({
      ...input,
      role_name: roleName,
      permission_keys: permissionKeys,
    });
  }

  async update(id: string, roleName: string) {
    this.validateId(id);
    const normalizedName = roleName.trim();
    if (normalizedName.length < 2)
      throw new BadRequestException(
        'Role name must contain at least 2 characters',
      );
    const role = await this.repository.findById(id);
    if (!role) throw new NotFoundException('Role not found');
    this.assertCustomRole(role.is_system);
    const updated = await this.repository.updateName(id, normalizedName);
    if (!updated) throw new NotFoundException('Role not found');
    return updated;
  }

  async replacePermissions(id: string, keys: string[]) {
    this.validateId(id);
    const permissionKeys = this.validatePermissionKeys(keys);
    const role = await this.repository.findById(id);
    if (!role) throw new NotFoundException('Role not found');
    this.assertCustomRole(role.is_system);
    const updated = await this.repository.replacePermissions(
      id,
      permissionKeys,
    );
    if (!updated) throw new NotFoundException('Role not found');
    return updated;
  }

  async deactivate(id: string) {
    this.validateId(id);
    const role = await this.repository.findById(id);
    if (!role) throw new NotFoundException('Role not found');
    this.assertCustomRole(role.is_system);
    const deactivated = await this.repository.deactivate(id);
    if (!deactivated) throw new NotFoundException('Role not found');
    return deactivated;
  }

  private validateId(id: string): void {
    if (!ROLE_ID_PATTERN.test(id) || BigInt(id) > 9_223_372_036_854_775_807n)
      throw new BadRequestException('Role ID must be a positive integer');
  }

  private validatePermissionKeys(keys: string[]): PermissionKey[] {
    if (
      !Array.isArray(keys) ||
      new Set(keys).size !== keys.length ||
      keys.some((key) => !PERMISSION_KEYS.has(key))
    )
      throw new BadRequestException(
        'Permission keys must be unique catalog entries',
      );
    return keys as PermissionKey[];
  }

  private assertCustomRole(isSystem: boolean): void {
    if (isSystem) throw new ForbiddenException('System roles are protected');
  }
}
