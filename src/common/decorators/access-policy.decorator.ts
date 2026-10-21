import { SetMetadata } from '@nestjs/common';
import type { PermissionKey } from '../../modules/access-control/permission-catalog';

export const ACCESS_PERMISSION_KEY = 'coms:access-permission';
export const BRANCH_SCOPE_KEY = 'coms:branch-scope';
export const ALLOW_UNASSIGNED_ROLE_KEY = 'coms:allow-unassigned-role';
export const SUPER_ADMIN_ONLY_KEY = 'coms:super-admin-only';
export const ALLOW_PENDING_PASSWORD_KEY = 'coms:allow-pending-password';
export const RequireSuperAdmin = () => SetMetadata(SUPER_ADMIN_ONLY_KEY, true);
export const RequirePermission = (permission: PermissionKey) =>
  SetMetadata(ACCESS_PERMISSION_KEY, permission);
export const RequireBranchScope = () => SetMetadata(BRANCH_SCOPE_KEY, true);
export const AllowUnassignedRole = () =>
  SetMetadata(ALLOW_UNASSIGNED_ROLE_KEY, true);
/** Reachable while a reset password still has to be changed. */
export const AllowPendingPasswordChange = () =>
  SetMetadata(ALLOW_PENDING_PASSWORD_KEY, true);
