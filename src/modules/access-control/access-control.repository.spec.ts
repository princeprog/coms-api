import { describe, expect, it, vi } from 'vitest';
import { AccessControlRepository } from './access-control.repository';

vi.mock('../../database/database.module', () => ({
  DATABASE: Symbol('DATABASE'),
}));

describe('AccessControlRepository', () => {
  it('loads active role grants and only active assigned branches', async () => {
    const userQuery = {
      select: vi.fn().mockReturnThis(),
      leftJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      executeTakeFirst: vi.fn().mockResolvedValue({
        user_id: 'user-1',
        account_active: true,
        role_id: '4',
        role_code: 'MANAGER',
        role_name: 'Manager',
        role_is_system: false,
        role_is_active: true,
      }),
    };
    const permissionQuery = {
      select: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      execute: vi
        .fn()
        .mockResolvedValue([{ module_key: 'inventory', action_key: 'read' }]),
    };
    const branchQuery = {
      select: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      execute: vi.fn().mockResolvedValue([{ branch_id: 'branch-1' }]),
    };
    const db = {
      selectFrom: vi
        .fn()
        .mockReturnValueOnce(userQuery)
        .mockReturnValueOnce(permissionQuery)
        .mockReturnValueOnce(branchQuery),
    };
    const repository = new AccessControlRepository(db as never);

    await expect(repository.findAccessContext('user-1')).resolves.toEqual({
      userId: 'user-1',
      accountActive: true,
      role: {
        id: '4',
        code: 'MANAGER',
        name: 'Manager',
        isSystem: false,
        isActive: true,
      },
      permissions: ['inventory.read'],
      branchIds: ['branch-1'],
    });
    expect(branchQuery.innerJoin).toHaveBeenCalledWith(
      'branches as b',
      'b.id',
      'bu.branch_id',
    );
    expect(branchQuery.where).toHaveBeenCalledWith('b.status', '=', 'active');
  });

  it('returns an empty access context for a user without an assigned role', async () => {
    const userQuery = {
      select: vi.fn().mockReturnThis(),
      leftJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      executeTakeFirst: vi.fn().mockResolvedValue({
        user_id: 'user-2',
        account_active: true,
        role_id: null,
        role_code: null,
        role_name: null,
        role_is_system: null,
        role_is_active: null,
      }),
    };
    const branchQuery = {
      select: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      execute: vi.fn().mockResolvedValue([{ branch_id: 'branch-2' }]),
    };
    const db = {
      selectFrom: vi
        .fn()
        .mockReturnValueOnce(userQuery)
        .mockReturnValueOnce(branchQuery),
    };
    const repository = new AccessControlRepository(db as never);

    await expect(repository.findAccessContext('user-2')).resolves.toEqual({
      userId: 'user-2',
      accountActive: true,
      role: null,
      permissions: [],
      branchIds: ['branch-2'],
    });
    expect(db.selectFrom).toHaveBeenCalledTimes(2);
  });
});
