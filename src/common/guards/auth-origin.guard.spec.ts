import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { AuthOriginGuard } from './auth-origin.guard';
import { AuthGatewayGuard } from './auth-gateway.guard';
function context(headers: Record<string, unknown>) {
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  } as ExecutionContext;
}
describe('auth gateway and origin guards', () => {
  it.each([undefined, 'https://attacker.example', 'http://localhost:3000/'])(
    'rejects missing/mismatched origin %s',
    (origin) => {
      expect(() =>
        new AuthOriginGuard().canActivate(context({ origin })),
      ).toThrow('Origin is not allowed');
    },
  );
  it('accepts exact origin', () => {
    expect(
      new AuthOriginGuard().canActivate(
        context({ origin: process.env.WEB_ORIGIN }),
      ),
    ).toBe(true);
  });
  it.each([undefined, 'wrong', ['bad'], 'a'.repeat(64)])(
    'rejects invalid gateway credential',
    (value) => {
      expect(() =>
        new AuthGatewayGuard().canActivate(
          context({ 'x-coms-auth-gateway': value }),
        ),
      ).toThrow('Authentication gateway required');
    },
  );
  it('accepts the server credential', () => {
    expect(
      new AuthGatewayGuard().canActivate(
        context({
          'x-coms-auth-gateway': process.env.COMS_AUTH_GATEWAY_SECRET,
        }),
      ),
    ).toBe(true);
  });
});
