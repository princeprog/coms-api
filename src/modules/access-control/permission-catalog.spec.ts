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
});
