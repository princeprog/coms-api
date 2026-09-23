import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import {
  ACCESS_PERMISSION_KEY,
  BRANCH_SCOPE_KEY,
} from '../decorators/access-policy.decorator';
import { AccessControlGuard } from './access-control.guard';

vi.mock('../../database/database.module', () => ({
  DATABASE: Symbol('DATABASE'),
}));

function executionContext(request: Record<string, unknown>): ExecutionContext {
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('AccessControlGuard', () => {
  it('adds the current role, grants, and branch assignments to the request', async () => {
    const context = {
      userId: 'user-1',
      accountActive: true,
      role: {
        id: '1',
        code: 'MANAGER',
        name: 'Manager',
        isSystem: false,
        isActive: true,
      },
      permissions: ['inventory.read'],
      branchIds: ['branch-1'],
    };
    const service = { findAccessContext: vi.fn().mockResolvedValue(context) };
    const reflector = { getAllAndOverride: vi.fn().mockReturnValue(undefined) };
    const request = { user: { id: 'user-1' } };

    await expect(
      new AccessControlGuard(service as never, reflector as never).canActivate(
        executionContext(request),
      ),
    ).resolves.toBe(true);
    expect(request).toHaveProperty('accessContext', context);
  });

  it('rejects inactive accounts and inactive roles', async () => {
    const reflector = { getAllAndOverride: vi.fn().mockReturnValue(undefined) };
    const request = { user: { id: 'user-1' } };
    const guard = new AccessControlGuard(
      {
        findAccessContext: vi.fn().mockResolvedValue({ accountActive: false }),
      } as never,
      reflector as never,
    );
    await expect(
      guard.canActivate(executionContext(request)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    const inactiveRoleGuard = new AccessControlGuard(
      {
        findAccessContext: vi.fn().mockResolvedValue({
          accountActive: true,
          role: { isActive: false },
        }),
      } as never,
      reflector as never,
    );
    await expect(
      inactiveRoleGuard.canActivate(executionContext(request)),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('requires a grant and assigned branch unless protected Super Admin', async () => {
    const service = {
      findAccessContext: vi.fn().mockResolvedValue({
        userId: 'user-1',
        accountActive: true,
        role: { code: 'MANAGER', isSystem: false, isActive: true },
        permissions: [],
        branchIds: ['branch-1'],
      }),
    };
    const reflector = {
      getAllAndOverride: vi.fn((key: string) =>
        key === ACCESS_PERMISSION_KEY
          ? 'inventory.read'
          : key === BRANCH_SCOPE_KEY
            ? true
            : undefined,
      ),
    };
    const request = {
      user: { id: 'user-1' },
      params: { branchId: 'branch-2' },
    };
    const guard = new AccessControlGuard(service as never, reflector as never);
    await expect(
      guard.canActivate(executionContext(request)),
    ).rejects.toBeInstanceOf(ForbiddenException);
    const mismatchedRequest = {
      user: { id: 'user-1' },
      params: { branchId: 'branch-1' },
      body: { branch_id: 'branch-2' },
    };
    await expect(
      guard.canActivate(executionContext(mismatchedRequest)),
    ).rejects.toBeInstanceOf(ForbiddenException);

    service.findAccessContext.mockResolvedValue({
      userId: 'user-1',
      accountActive: true,
      role: { code: 'SUPER_ADMIN', isSystem: false, isActive: true },
      permissions: [],
      branchIds: [],
    });
    await expect(
      guard.canActivate(executionContext(request)),
    ).rejects.toBeInstanceOf(ForbiddenException);

    service.findAccessContext.mockResolvedValue({
      userId: 'user-1',
      accountActive: true,
      role: { code: 'SUPER_ADMIN', isSystem: true, isActive: true },
      permissions: [],
      branchIds: [],
    });
    await expect(guard.canActivate(executionContext(request))).resolves.toBe(
      true,
    );
  });

  it('returns 401 when a session guard has not established a user', async () => {
    const service = { findAccessContext: vi.fn() };
    const guard = new AccessControlGuard(service as never, new Reflector());
    await expect(
      guard.canActivate(executionContext({})),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
