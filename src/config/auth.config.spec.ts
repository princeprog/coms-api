import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import { getAuthConfig } from './auth.config';
import { validAuthEnv } from '../../test/auth-test-env';
describe('auth configuration', () => {
  beforeEach(() => Object.assign(process.env, validAuthEnv));
  afterEach(() => vi.unstubAllEnvs());
  it('loads durations and default limits', () => {
    expect(getAuthConfig()).toMatchObject({
      accessTtlSeconds: 900,
      refreshTtlSeconds: 2592000,
      loginLimit: 10,
      refreshLimit: 20,
      capacityLimit: 600,
    });
  });
  it.each([
    '',
    'short',
    'a'.repeat(64),
    '0123456789abcdef'.repeat(4),
    'g'.repeat(64),
  ])('rejects weak or malformed secrets: %s', (value) => {
    vi.stubEnv('JWT_ACCESS_SECRET', value);
    expect(() => getAuthConfig()).toThrow(/hexadecimal/);
  });
  it('rejects equal secrets including different casing', () => {
    vi.stubEnv(
      'COMS_AUTH_GATEWAY_SECRET',
      validAuthEnv.JWT_ACCESS_SECRET.toUpperCase(),
    );
    expect(() => getAuthConfig()).toThrow(/different/);
  });
  it.each([
    '',
    'example.com',
    'https://example.com/path',
    'https://example.com/',
    'ftp://example.com',
  ])('rejects invalid origin %s', (value) => {
    vi.stubEnv('WEB_ORIGIN', value);
    expect(() => getAuthConfig()).toThrow(/WEB_ORIGIN/);
  });
  it.each(['0', '-1', '1.5', 'abc', 'Infinity'])(
    'rejects invalid rate limit %s',
    (value) => {
      vi.stubEnv('AUTH_LOGIN_LIMIT_PER_MINUTE', value);
      expect(() => getAuthConfig()).toThrow(/positive/);
    },
  );
  it('rejects invalid durations', () => {
    vi.stubEnv('JWT_ACCESS_EXPIRES_IN', '900');
    expect(() => getAuthConfig()).toThrow(/duration/);
    vi.stubEnv('JWT_ACCESS_EXPIRES_IN', '31d');
    expect(() => getAuthConfig()).toThrow(/shorter/);
  });
});
