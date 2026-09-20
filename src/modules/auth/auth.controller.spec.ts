import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SESSION_COOKIE,
  SESSION_COOKIE_OPTIONS,
} from '../../common/constants/auth.constants';
import { AuthController } from './auth.controller';

vi.mock('../../database/database.module', () => ({
  DATABASE: Symbol('DATABASE'),
}));

describe('AuthController', () => {
  let controller: AuthController;
  let authService: {
    register: ReturnType<typeof vi.fn>;
    login: ReturnType<typeof vi.fn>;
    logout: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    authService = {
      register: vi.fn().mockResolvedValue({
        token: 'register-token',
        user: { id: '1', email: 'alice@example.com' },
      }),
      login: vi.fn().mockResolvedValue({
        token: 'login-token',
        user: { id: '1', email: 'alice@example.com' },
      }),
      logout: vi.fn().mockResolvedValue(undefined),
    };

    controller = new AuthController(authService as never);
  });

  it('sets the secure session cookie after registration', async () => {
    const response = {
      cookie: vi.fn(),
      header: vi.fn(),
    };

    const result = await controller.register(
      {
        email: 'alice@example.com',
        password: 'correct horse battery staple',
        fullName: 'Alice Example',
        contactNumber: '+639171234567',
      },
      response as never,
    );

    expect(result).toEqual({
      user: { id: '1', email: 'alice@example.com' },
    });
    expect(response.cookie).toHaveBeenCalledWith(
      SESSION_COOKIE,
      'register-token',
      SESSION_COOKIE_OPTIONS,
    );
  });

  it('sets the secure session cookie after login', async () => {
    const response = {
      cookie: vi.fn(),
      header: vi.fn(),
    };

    await controller.login(
      {
        email: 'alice@example.com',
        password: 'correct horse battery staple',
      },
      response as never,
    );

    expect(response.cookie).toHaveBeenCalledWith(
      SESSION_COOKIE,
      'login-token',
      SESSION_COOKIE_OPTIONS,
    );
  });

  it('revokes the cookie session and clears the browser cookie on logout', async () => {
    const response = {
      req: { cookies: { [SESSION_COOKIE]: 'session-token' } },
      clearCookie: vi.fn(),
      header: vi.fn(),
    };

    await controller.logout(response.req as never, response as never);

    expect(authService.logout).toHaveBeenCalledWith('session-token');
    expect(response.clearCookie).toHaveBeenCalledWith(SESSION_COOKIE, {
      path: '/',
    });
  });
});
