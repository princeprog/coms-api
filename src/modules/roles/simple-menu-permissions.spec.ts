import '../../config/load-env';
import { RolesService } from './roles.service';
import { expect, it } from 'vitest';
it('omits retired and Super Admin-only capabilities from editable roles', () => {
  const service = new RolesService({} as never);
  const keys = service.listPermissions().map((p) => p.key);
  for (const key of [
    'recipes.read',
    'menu_requests.create',
    'menu_templates.read',
    'products.create',
    'products.update',
    'branch_products.create',
    'branch_products.availability_update',
  ])
    expect(keys).not.toContain(key);
  expect(keys).toContain('products.read');
  expect(keys).toContain('branch_products.read');
  expect(keys).toContain('sales.create');
});
