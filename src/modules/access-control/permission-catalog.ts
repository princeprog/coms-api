export const PERMISSION_CATALOG = [
  {
    module_key: 'roles',
    action_key: 'read',
    description: 'View roles and permissions',
  },
  { module_key: 'roles', action_key: 'create', description: 'Create roles' },
  { module_key: 'roles', action_key: 'update', description: 'Update roles' },
  {
    module_key: 'roles',
    action_key: 'deactivate',
    description: 'Deactivate roles',
  },
  {
    module_key: 'roles',
    action_key: 'permissions_update',
    description: 'Change role permission grants',
  },
  {
    module_key: 'staff',
    action_key: 'read',
    description: 'View staff accounts',
  },
  {
    module_key: 'staff',
    action_key: 'create',
    description: 'Create staff accounts',
  },
  {
    module_key: 'staff',
    action_key: 'update',
    description: 'Update staff accounts',
  },
  {
    module_key: 'staff',
    action_key: 'deactivate',
    description: 'Deactivate staff accounts',
  },
  {
    module_key: 'staff',
    action_key: 'role_assign',
    description: 'Assign roles to staff',
  },
  {
    module_key: 'staff',
    action_key: 'branch_assign',
    description: 'Assign staff to branches',
  },
  { module_key: 'branches', action_key: 'read', description: 'View branches' },
  {
    module_key: 'branches',
    action_key: 'create',
    description: 'Create branches',
  },
  {
    module_key: 'branches',
    action_key: 'update',
    description: 'Update branches',
  },
  {
    module_key: 'branches',
    action_key: 'deactivate',
    description: 'Deactivate branches',
  },
  {
    module_key: 'suppliers',
    action_key: 'read',
    description: 'View suppliers',
  },
  {
    module_key: 'suppliers',
    action_key: 'create',
    description: 'Create suppliers',
  },
  {
    module_key: 'suppliers',
    action_key: 'update',
    description: 'Update suppliers',
  },
  {
    module_key: 'suppliers',
    action_key: 'deactivate',
    description: 'Deactivate suppliers',
  },
  {
    module_key: 'stock_items',
    action_key: 'read',
    description: 'View stock items',
  },
  {
    module_key: 'stock_items',
    action_key: 'create',
    description: 'Create stock items',
  },
  {
    module_key: 'stock_items',
    action_key: 'update',
    description: 'Update stock items',
  },
  {
    module_key: 'stock_items',
    action_key: 'deactivate',
    description: 'Deactivate stock items',
  },
  {
    module_key: 'inventory',
    action_key: 'read',
    description: 'View inventory',
  },
  {
    module_key: 'inventory',
    action_key: 'adjust',
    description: 'Adjust inventory with a reason',
  },
  {
    module_key: 'supplier_receipts',
    action_key: 'read',
    description: 'View supplier receipts',
  },
  {
    module_key: 'supplier_receipts',
    action_key: 'create',
    description: 'Record supplier receipts',
  },
  {
    module_key: 'supplier_receipts',
    action_key: 'post',
    description: 'Post supplier receipts to inventory',
  },
  {
    module_key: 'stock_requests',
    action_key: 'read',
    description: 'View stock requests',
  },
  {
    module_key: 'stock_requests',
    action_key: 'create',
    description: 'Create branch stock requests',
  },
  {
    module_key: 'stock_requests',
    action_key: 'approve',
    description: 'Approve stock requests',
  },
  {
    module_key: 'stock_requests',
    action_key: 'reject',
    description: 'Reject stock requests',
  },
  {
    module_key: 'stock_requests',
    action_key: 'cancel',
    description: 'Cancel own stock requests',
  },
  {
    module_key: 'dispatches',
    action_key: 'read',
    description: 'View dispatches',
  },
  {
    module_key: 'dispatches',
    action_key: 'create',
    description: 'Prepare dispatches',
  },
  {
    module_key: 'dispatches',
    action_key: 'dispatch',
    description: 'Dispatch stock to a branch',
  },
  {
    module_key: 'dispatches',
    action_key: 'receive',
    description: 'Record branch dispatch receipts',
  },
  {
    module_key: 'dispatches',
    action_key: 'shortage_close',
    description: 'Close an in-transit shortage with a reason',
  },
  { module_key: 'products', action_key: 'read', description: 'View products' },
  {
    module_key: 'products',
    action_key: 'create',
    description: 'Create products',
  },
  {
    module_key: 'products',
    action_key: 'update',
    description: 'Update products',
  },
  {
    module_key: 'products',
    action_key: 'deactivate',
    description: 'Deactivate products',
  },
  {
    module_key: 'recipes',
    action_key: 'read',
    description: 'View product recipes',
  },
  {
    module_key: 'recipes',
    action_key: 'create',
    description: 'Create product recipes',
  },
  {
    module_key: 'recipes',
    action_key: 'update',
    description: 'Update product recipes',
  },
  {
    module_key: 'recipes',
    action_key: 'deactivate',
    description: 'Deactivate product recipes',
  },
  {
    module_key: 'branch_products',
    action_key: 'read',
    description: 'View branch offerings',
  },
  {
    module_key: 'branch_products',
    action_key: 'create',
    description: 'Create branch offerings',
  },
  {
    module_key: 'branch_products',
    action_key: 'update',
    description: 'Update branch prices and offerings',
  },
  {
    module_key: 'branch_products',
    action_key: 'availability_update',
    description: 'Change branch product availability',
  },
  { module_key: 'sales', action_key: 'read', description: 'View sales' },
  {
    module_key: 'sales',
    action_key: 'create',
    description: 'Record point-of-sale transactions',
  },
  {
    module_key: 'sales',
    action_key: 'void',
    description: 'Void sales with a reason',
  },
  {
    module_key: 'daily_reports',
    action_key: 'read',
    description: 'View daily reports',
  },
  {
    module_key: 'daily_reports',
    action_key: 'create',
    description: 'Create daily reports',
  },
  {
    module_key: 'daily_reports',
    action_key: 'update',
    description: 'Update draft daily reports',
  },
  {
    module_key: 'daily_reports',
    action_key: 'submit',
    description: 'Submit daily reports for review',
  },
  {
    module_key: 'daily_reports',
    action_key: 'return',
    description: 'Return daily reports for correction',
  },
  {
    module_key: 'daily_reports',
    action_key: 'approve',
    description: 'Approve daily reports',
  },
] as const;

export type PermissionKey =
  `${(typeof PERMISSION_CATALOG)[number]['module_key']}.${(typeof PERMISSION_CATALOG)[number]['action_key']}`;
