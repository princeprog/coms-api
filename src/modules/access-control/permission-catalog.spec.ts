import { describe, expect, it } from 'vitest';
import { PERMISSION_CATALOG } from './permission-catalog';

describe('role-scoped operations permission catalog', () => {
  it('defines dashboard scopes and dispatch reconciliation', () => {
    const permissionKeys = PERMISSION_CATALOG.map(
      ({ module_key, action_key }) => `${module_key}.${action_key}`,
    );

    expect(permissionKeys).toContain('dashboard.read');
    expect(permissionKeys).toContain('dashboard.global_read');
    expect(permissionKeys).toContain('dispatches.reconcile');
  });

  it('exposes direct supplier receiving and no retired request or receipt-post permissions', () => {
    const permissionKeys = PERMISSION_CATALOG.map(
      ({ module_key, action_key }) => `${module_key}.${action_key}`,
    );
    expect(permissionKeys).toContain('supplier_receipts.create');
    expect(permissionKeys).not.toContain('supplier_receipts.post');
    expect(permissionKeys.filter((key) => key.startsWith('stock_requests.'))).toEqual([]);
    expect(
      PERMISSION_CATALOG.find(
        ({ module_key, action_key }) =>
          module_key === 'supplier_receipts' && action_key === 'create',
      )?.description,
    ).toMatch(/immediately add received quantities to commissary inventory/i);
  });
});
