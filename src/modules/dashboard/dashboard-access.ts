import { ForbiddenException } from '@nestjs/common';
import type { AccessContext } from '../access-control/access-control.types';
import type { PermissionKey } from '../access-control/permission-catalog';
import type { TodayScope } from './dashboard-today.repository';

export function isSuperAdmin(access: AccessContext) {
  return Boolean(
    access.role?.isSystem &&
    access.role.isActive &&
    access.role.code === 'SUPER_ADMIN',
  );
}

export function dashboardCan(access: AccessContext) {
  const superAdmin = isSuperAdmin(access);
  return (permission: PermissionKey) =>
    superAdmin || access.permissions.includes(permission);
}

/** Super Admin and global readers see every branch; others their own. */
export function dashboardScope(
  access: AccessContext,
  branchId?: string,
): TodayScope {
  const global =
    isSuperAdmin(access) ||
    access.permissions.includes('dashboard.global_read');
  if (global) return branchId ? [branchId] : null;
  if (!access.branchIds.length)
    throw new ForbiddenException('Branch access required');
  if (branchId) {
    if (!access.branchIds.includes(branchId))
      throw new ForbiddenException('Branch access required');
    return [branchId];
  }
  return access.branchIds;
}
