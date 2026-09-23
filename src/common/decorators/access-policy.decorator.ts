import { SetMetadata } from '@nestjs/common';
import type { PermissionKey } from '../../modules/access-control/permission-catalog';
import type { AccessPolicy } from '../../modules/access-control/access-control.types';

export const ACCESS_POLICY_KEY = 'coms:access-policy';
export const RequirePermission = (permission: PermissionKey) =>
  SetMetadata(ACCESS_POLICY_KEY, { permission } satisfies AccessPolicy);
export const RequireBranchScope = () =>
  SetMetadata(ACCESS_POLICY_KEY, { branchScoped: true } satisfies AccessPolicy);
