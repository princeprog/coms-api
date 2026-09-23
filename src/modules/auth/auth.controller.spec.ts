import { describe, expect, it, vi } from 'vitest';
import { AuthController } from './auth.controller';
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  TOKEN_COOKIE_OPTIONS,
} from '../../common/constants/auth.constants';
vi.mock('../../database/database.module', () => ({
  DATABASE: Symbol('DATABASE'),
}));
describe('auth cookies', () => {
  it('uses actual token expiry for rotated refresh cookies', async () => {
    const expiry = new Date(Date.now() + 60000);
    const service = {
      refresh: vi.fn().mockResolvedValue({
        user: { id: 'test' },
        tokens: {
          accessToken: 'access',
          refreshToken: 'refresh',
          accessExpiresAt: expiry,
          refreshExpiresAt: expiry,
        },
      }),
    };
    const response = { cookie: vi.fn(), header: vi.fn() };
    await new AuthController(service as never, {} as never).refresh(
      { cookies: { [REFRESH_COOKIE]: 'old' } } as never,
      response as never,
    );
    expect(response.cookie).toHaveBeenCalledWith(
      REFRESH_COOKIE,
      'refresh',
      expect.objectContaining({ ...TOKEN_COOKIE_OPTIONS, expires: expiry }),
    );
    expect(response.cookie.mock.calls[1][2]).not.toHaveProperty('maxAge');
  });
  it('expires both cookies with all issuance attributes', async () => {
    const service = { logout: vi.fn() };
    const response = { cookie: vi.fn(), header: vi.fn() };
    await new AuthController(service as never, {} as never).logout(
      { cookies: {} } as never,
      response as never,
    );
    for (const name of [ACCESS_COOKIE, REFRESH_COOKIE])
      expect(response.cookie).toHaveBeenCalledWith(name, '', {
        ...TOKEN_COOKIE_OPTIONS,
        maxAge: 0,
        expires: new Date(0),
      });
  });
});
