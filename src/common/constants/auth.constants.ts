import type { CookieOptions } from 'express';

const isProduction = process.env.NODE_ENV === 'production';

export const SESSION_COOKIE = isProduction
  ? '__Host-coms_session'
  : 'coms_session';

export const SESSION_TTL_MS =
  Number(process.env.SESSION_TTL_SECONDS ?? 28_800) * 1000;

export const SESSION_COOKIE_OPTIONS: CookieOptions = {
  httpOnly: true,
  secure: isProduction,
  sameSite: 'lax',
  path: '/',
  maxAge: SESSION_TTL_MS,
};
