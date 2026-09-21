import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from './auth.service';

vi.mock('../../database/database.module', () => ({
  DATABASE: Symbol('DATABASE'),
}));
process.env.JWT_ACCESS_SECRET = 'a'.repeat(64);
process.env.JWT_REFRESH_SECRET = 'b'.repeat(64);
process.env.JWT_ACCESS_EXPIRES_IN = '15m';
process.env.JWT_REFRESH_EXPIRES_IN = '30d';

const user = {
  id: randomUUID(),
  email: 'alice@example.com',
  full_name: 'Alice Example',
  contact_number: '+639171234567',
  hashed_password: '',
  created_at: new Date(),
  updated_at: new Date(),
};
function builder(result?: unknown) {
  return {
    select: vi.fn().mockReturnThis(),
    selectAll: vi.fn().mockReturnThis(),
    returning: vi.fn().mockReturnThis(),
    returningAll: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    executeTakeFirst: vi.fn().mockResolvedValue(result),
    executeTakeFirstOrThrow: vi.fn().mockResolvedValue(result),
    execute: vi.fn().mockResolvedValue([]),
    forUpdate: vi.fn().mockReturnThis(),
  };
}
function createDatabase(options?: {
  existingUser?: unknown;
  loginUser?: unknown;
}) {
  const userInsert = builder(user);
  const family = {
    id: randomUUID(),
    user_id: user.id,
    expires_at: new Date(Date.now() + 86_400_000),
    created_at: new Date(),
    revoked_at: null,
  };
  const familyInsert = builder(family);
  const refreshInsert = builder();
  const insertFor = (table: string) =>
    table === 'auth.users'
      ? userInsert
      : table === 'auth.token_families'
        ? familyInsert
        : refreshInsert;
  const transaction = {
    selectFrom: vi.fn().mockReturnValue(builder(options?.existingUser)),
    insertInto: vi.fn(insertFor),
    updateTable: vi.fn().mockReturnValue(builder()),
  };
  const database = {
    transaction: vi
      .fn()
      .mockReturnValue({
        execute: vi.fn((callback: (trx: unknown) => unknown) =>
          callback(transaction),
        ),
      }),
    selectFrom: vi.fn().mockReturnValue(builder(options?.loginUser)),
    insertInto: vi.fn(insertFor),
    updateTable: vi.fn().mockReturnValue(builder()),
  };
  return { database, userInsert };
}

describe('AuthService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('registers a normalized user and issues a token pair', async () => {
    const fake = createDatabase();
    const service = new AuthService(fake.database as never, new JwtService());
    const result = await service.register({
      email: ' Alice@Example.com ',
      password: 'correct horse battery staple',
      fullName: ' Alice Example ',
      contactNumber: ' +639171234567 ',
    });
    expect(result.user).toEqual({
      id: user.id,
      email: 'alice@example.com',
      full_name: 'Alice Example',
      contact_number: '+639171234567',
    });
    expect(result.tokens.accessToken).toEqual(expect.any(String));
    expect(result.tokens.refreshToken).toEqual(expect.any(String));
    expect(fake.userInsert.values).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'alice@example.com',
        hashed_password: expect.stringMatching(/^\$argon2id\$/),
      }),
    );
  });

  it('rejects duplicate registration', async () => {
    const fake = createDatabase({ existingUser: { id: randomUUID() } });
    const service = new AuthService(fake.database as never, new JwtService());
    await expect(
      service.register({
        email: 'alice@example.com',
        password: 'correct horse battery staple',
        fullName: 'Alice Example',
        contactNumber: '+639171234567',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('logs in with valid credentials and rejects invalid credentials', async () => {
    const hashedPassword = await argon2.hash('correct horse battery staple');
    const fake = createDatabase({
      loginUser: { ...user, hashed_password: hashedPassword },
    });
    const service = new AuthService(fake.database as never, new JwtService());
    const result = await service.login({
      email: ' ALICE@EXAMPLE.COM ',
      password: 'correct horse battery staple',
    });
    expect(result.user.email).toBe('alice@example.com');
    const missing = createDatabase();
    await expect(
      new AuthService(missing.database as never, new JwtService()).login({
        email: 'missing@example.com',
        password: 'wrong password',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a token signed with the wrong secret', async () => {
    const service = new AuthService(
      createDatabase().database as never,
      new JwtService(),
    );
    const wrongSecret = await new JwtService().signAsync(
      {
        sub: user.id,
        type: 'refresh',
        familyId: randomUUID(),
        jti: randomUUID(),
      },
      { secret: 'wrong'.repeat(16), algorithm: 'HS256' },
    );
    await expect(service.refresh(wrongSecret)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
