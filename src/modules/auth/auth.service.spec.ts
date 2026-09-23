import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { AuthService } from './auth.service';
vi.mock('../../database/database.module', () => ({
  DATABASE: Symbol('DATABASE'),
}));
describe('JWT boundary validation', () => {
  const jwt = new JwtService();
  const now = Math.floor(Date.now() / 1000);
  const base = {
    sub: randomUUID(),
    familyId: randomUUID(),
    jti: randomUUID(),
    type: 'access',
    iat: now,
    exp: now + 900,
    iss: 'coms-api',
    aud: 'coms-web',
  };
  it.each([
    { type: 'refresh' },
    { exp: undefined },
    { exp: now - 1 },
    { sub: {} },
    { sub: 'not-a-uuid' },
    { familyId: 42 },
    { jti: true },
    { iat: now + 60 },
    { iss: 'attacker' },
    { aud: 'other-app' },
  ])('rejects malformed or wrong claims %j', async (changes) => {
    const repo = { findFamily: vi.fn() };
    const service = new AuthService(repo as never, jwt, {} as never);
    const claims = { ...base, ...changes } as Record<string, unknown>;
    if (claims.exp === undefined) delete claims.exp;
    const token = await jwt.signAsync(claims, {
      secret: process.env.JWT_ACCESS_SECRET,
      algorithm: 'HS256',
    });
    expect(await service.authenticateAccess(token)).toBeNull();
    expect(repo.findFamily).not.toHaveBeenCalled();
  });
  it('rejects wrong signing key and algorithm', async () => {
    const service = new AuthService({} as never, jwt, {} as never);
    for (const options of [
      { secret: process.env.JWT_REFRESH_SECRET, algorithm: 'HS256' as const },
      { secret: process.env.JWT_ACCESS_SECRET, algorithm: 'HS384' as const },
    ]) {
      expect(
        await service.authenticateAccess(await jwt.signAsync(base, options)),
      ).toBeNull();
    }
  });
});
