import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { SESSION_COOKIE } from '../constants/auth.constants';
import { AuthGuard } from './auth.guard';

vi.mock('../../database/database.module', () => ({
  DATABASE: Symbol('DATABASE'),
}));

describe('AuthGuard', () => {
  it('attaches the authenticated session to the request', async () => {
    const request = { cookies: { [SESSION_COOKIE]: 'session-token' } } as any;
    const authService = {
      authenticateSession: vi.fn().mockResolvedValue({
        sessionId: 'session-id',
        user: { id: 'user-id', email: 'alice@example.com' },
      }),
    };
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;

    const result = await new AuthGuard(authService as never).canActivate(
      context,
    );

    expect(result).toBe(true);
    expect(request.user.email).toBe('alice@example.com');
    expect(request.sessionId).toBe('session-id');
  });

  it('rejects missing or invalid sessions', async () => {
    const request = { cookies: {} } as any;
    const authService = {
      authenticateSession: vi.fn().mockResolvedValue(null),
    };
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;

    await expect(
      new AuthGuard(authService as never).canActivate(context),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
