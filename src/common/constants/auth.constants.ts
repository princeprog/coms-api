import type { CookieOptions } from 'express';

const isProduction = process.env.NODE_ENV === 'production';

export const ACCESS_COOKIE = isProduction
  ? '__Host-coms_access'
  : 'coms_access';
export const REFRESH_COOKIE = isProduction
  ? '__Host-coms_refresh'
  : 'coms_refresh';

export const TOKEN_COOKIE_OPTIONS: CookieOptions = {
  httpOnly: true,
  secure: isProduction,
  sameSite: 'lax',
  path: '/',
};
