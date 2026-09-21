import { beforeEach, describe, expect, it } from 'vitest';

import { getAuthConfig } from './auth.config';

const validEnv = {
  JWT_ACCESS_SECRET: 'a'.repeat(64),
  JWT_REFRESH_SECRET: 'b'.repeat(64),
  JWT_ACCESS_EXPIRES_IN: '15m',
  JWT_REFRESH_EXPIRES_IN: '30d',
};

describe('getAuthConfig', () => {
  beforeEach(() => {
    Object.assign(process.env, validEnv);
  });

  it('loads validated JWT settings', () => {
    expect(getAuthConfig()).toMatchObject({
      accessTtlSeconds: 900,
      refreshTtlSeconds: 2_592_000,
    });
  });

  it('rejects weak or duplicate secrets', () => {
    process.env.JWT_ACCESS_SECRET = 'short';
    expect(() => getAuthConfig()).toThrow(/at least 32 bytes/);

    process.env.JWT_ACCESS_SECRET = validEnv.JWT_REFRESH_SECRET;
    expect(() => getAuthConfig()).toThrow(/must be different/);
  });

  it('rejects invalid durations and an access lifetime that is too long', () => {
    process.env.JWT_ACCESS_EXPIRES_IN = '900';
    expect(() => getAuthConfig()).toThrow(/duration/);

    process.env.JWT_ACCESS_EXPIRES_IN = '31d';
    expect(() => getAuthConfig()).toThrow(/shorter/);
  });
});
