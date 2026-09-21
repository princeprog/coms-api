import { ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { AuthOriginGuard } from './auth-origin.guard';

function context(origin?: string) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers: { origin } }),
    }),
  } as unknown as ExecutionContext;
}

describe('AuthOriginGuard', () => {
  it('allows requests without an origin', () => {
    expect(new AuthOriginGuard().canActivate(context())).toBe(true);
  });

  it('rejects an origin outside the configured web origin', () => {
    process.env.WEB_ORIGIN = 'http://localhost:3000';

    expect(() =>
      new AuthOriginGuard().canActivate(context('https://attacker.example')),
    ).toThrow('Origin is not allowed');
  });
});
