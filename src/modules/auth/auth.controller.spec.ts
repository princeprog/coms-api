import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
} from '../../common/constants/auth.constants';
import { AuthController } from './auth.controller';

vi.mock('../../database/database.module', () => ({
  DATABASE: Symbol('DATABASE'),
}));

process.env.JWT_ACCESS_SECRET = 'a'.repeat(64);
process.env.JWT_REFRESH_SECRET = 'b'.repeat(64);
process.env.JWT_ACCESS_EXPIRES_IN = '15m';
process.env.JWT_REFRESH_EXPIRES_IN = '30d';

describe('AuthController', () => {
  let controller: AuthController;
  let authService: Record<string, ReturnType<typeof vi.fn>>;
  let rateLimiter: { assertAllowed: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    authService = {
      register: vi
        .fn()
        .mockResolvedValue({
          tokens: {
            accessToken: 'register-access',
            refreshToken: 'register-refresh',
          },
          user: { id: '1', email: 'alice@example.com' },
        }),
      login: vi
        .fn()
        .mockResolvedValue({
          tokens: {
            accessToken: 'login-access',
            refreshToken: 'login-refresh',
          },
          user: { id: '1', email: 'alice@example.com' },
        }),
      refresh: vi
        .fn()
        .mockResolvedValue({
          tokens: { accessToken: 'new-access', refreshToken: 'new-refresh' },
          user: { id: '1', email: 'alice@example.com' },
        }),
      logout: vi.fn().mockResolvedValue(undefined),
    };
    rateLimiter = { assertAllowed: vi.fn() };
    controller = new AuthController(authService as never, rateLimiter as never);
  });

  it('sets both HttpOnly auth cookies after login', async () => {
    const response = { cookie: vi.fn(), header: vi.fn() };
    await controller.login(
      { email: 'alice@example.com', password: 'password' },
      { ip: '127.0.0.1' } as never,
      response as never,
    );
    expect(response.cookie).toHaveBeenCalledWith(
      ACCESS_COOKIE,
      'login-access',
      expect.objectContaining({ httpOnly: true, maxAge: 900000 }),
    );
    expect(response.cookie).toHaveBeenCalledWith(
      REFRESH_COOKIE,
      'login-refresh',
      expect.objectContaining({ httpOnly: true }),
    );
  });

  it('rotates both cookies on refresh', async () => {
    const response = { cookie: vi.fn(), header: vi.fn() };
    await controller.refresh(
      {
        ip: '127.0.0.1',
        cookies: { [REFRESH_COOKIE]: 'old-refresh' },
      } as never,
      response as never,
    );
    expect(authService.refresh).toHaveBeenCalledWith('old-refresh');
    expect(response.cookie).toHaveBeenCalledWith(
      ACCESS_COOKIE,
      'new-access',
      expect.any(Object),
    );
    expect(response.cookie).toHaveBeenCalledWith(
      REFRESH_COOKIE,
      'new-refresh',
      expect.any(Object),
    );
  });

  it('revokes the family and clears both cookies on logout', async () => {
    const response = { clearCookie: vi.fn(), header: vi.fn() };
    await controller.logout(
      {
        cookies: { [ACCESS_COOKIE]: 'access', [REFRESH_COOKIE]: 'refresh' },
      } as never,
      response as never,
    );
    expect(authService.logout).toHaveBeenCalledWith('access', 'refresh');
    expect(response.clearCookie).toHaveBeenCalledWith(ACCESS_COOKIE, {
      path: '/',
    });
    expect(response.clearCookie).toHaveBeenCalledWith(REFRESH_COOKIE, {
      path: '/',
    });
  });
});
