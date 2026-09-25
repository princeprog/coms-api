import type { PermissionKey } from './permission-catalog';

export type AccessContext = {
  userId: string;
  accountActive: boolean;
  role: {
    id: string;
    code: string;
    name: string;
    isSystem: boolean;
    isActive: boolean;
  } | null;
  permissions: PermissionKey[];
  branchIds: string[];
};
