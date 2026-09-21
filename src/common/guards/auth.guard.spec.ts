import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { ACCESS_COOKIE } from '../constants/auth.constants';
import { AuthGuard } from './auth.guard';

vi.mock('../../database/database.module', () => ({
  DATABASE: Symbol('DATABASE'),
}));

describe('AuthGuard', () => {
  it('attaches the authenticated JWT user', async () => {
    const request = { cookies: { [ACCESS_COOKIE]: 'access-token' } } as any;
    const user = { id: 'user-id', email: 'alice@example.com' };
    const authService = { authenticateAccess: vi.fn().mockResolvedValue(user) };
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
    await expect(
      new AuthGuard(authService as never).canActivate(context),
    ).resolves.toBe(true);
    expect(authService.authenticateAccess).toHaveBeenCalledWith('access-token');
    expect(request.user).toEqual(user);
  });

  it('rejects missing or invalid access tokens', async () => {
    const request = { cookies: { coms_session: 'legacy-token' } } as any;
    const authService = { authenticateAccess: vi.fn().mockResolvedValue(null) };
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
    await expect(
      new AuthGuard(authService as never).canActivate(context),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(authService.authenticateAccess).toHaveBeenCalledWith(undefined);
  });
});
