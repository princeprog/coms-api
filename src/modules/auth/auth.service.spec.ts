import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import * as argon2 from 'argon2';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthService } from './auth.service';

vi.mock('../../database/database.module', () => ({
  DATABASE: Symbol('DATABASE'),
}));

const user = {
  id: randomUUID(),
  email: 'alice@example.com',
  full_name: 'Alice Example',
  contact_number: '+639171234567',
  hashed_password: '',
  created_at: new Date(),
  updated_at: new Date(),
};

function selectBuilder(result: unknown) {
  return {
    select: vi.fn().mockReturnThis(),
    selectAll: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    executeTakeFirst: vi.fn().mockResolvedValue(result),
  };
}

function insertBuilder(result?: unknown) {
  return {
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockReturnThis(),
    executeTakeFirstOrThrow: vi.fn().mockResolvedValue(result),
    execute: vi.fn().mockResolvedValue([]),
  };
}

function createDatabase(options?: {
  existingUser?: unknown;
  loginUser?: unknown;
  sessionUser?: unknown;
}) {
  const userInsert = insertBuilder(user);
  const sessionInsert = insertBuilder();
  const transaction = {
    selectFrom: vi.fn().mockReturnValue(selectBuilder(options?.existingUser)),
    insertInto: vi
      .fn()
      .mockReturnValueOnce(userInsert)
      .mockReturnValueOnce(sessionInsert),
  };

  const database = {
    transaction: vi.fn().mockReturnValue({
      execute: vi.fn(async (callback: (trx: unknown) => unknown) =>
        callback(transaction),
      ),
    }),
    selectFrom: vi
      .fn()
      .mockReturnValueOnce(selectBuilder(options?.loginUser))
      .mockReturnValueOnce(selectBuilder(options?.sessionUser)),
    insertInto: vi.fn().mockReturnValue(sessionInsert),
    updateTable: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      execute: vi.fn().mockResolvedValue([]),
    }),
  };

  return { database, userInsert, sessionInsert };
}

describe('AuthService', () => {
  let service: AuthService;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers a normalized user and creates a session without exposing the password', async () => {
    const fake = createDatabase();
    service = new AuthService(fake.database as never);

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
    expect(result.user).not.toHaveProperty('hashed_password');
    expect(result.token).toEqual(expect.any(String));
    expect(fake.userInsert.values).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'alice@example.com',
        full_name: 'Alice Example',
        contact_number: '+639171234567',
        hashed_password: expect.stringMatching(/^\$argon2id\$/),
      }),
    );
    expect(fake.sessionInsert.values).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: user.id,
        token_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
  });

  it('rejects registration when the email or contact number is already used', async () => {
    const fake = createDatabase({ existingUser: { id: randomUUID() } });
    service = new AuthService(fake.database as never);

    await expect(
      service.register({
        email: 'alice@example.com',
        password: 'correct horse battery staple',
        fullName: 'Alice Example',
        contactNumber: '+639171234567',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('logs in with valid credentials and creates a session', async () => {
    const hashedPassword = await argon2.hash('correct horse battery staple');
    const fake = createDatabase({
      loginUser: { ...user, hashed_password: hashedPassword },
    });
    service = new AuthService(fake.database as never);

    const result = await service.login({
      email: ' ALICE@EXAMPLE.COM ',
      password: 'correct horse battery staple',
    });

    expect(result.user.email).toBe('alice@example.com');
    expect(result.token).toEqual(expect.any(String));
  });

  it('uses the same unauthorized error for an unknown user and a wrong password', async () => {
    const fake = createDatabase();
    service = new AuthService(fake.database as never);

    await expect(
      service.login({
        email: 'missing@example.com',
        password: 'wrong password',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects revoked or expired sessions', async () => {
    const fake = createDatabase({ sessionUser: undefined });
    service = new AuthService(fake.database as never);

    await expect(
      service.authenticateSession('expired-or-revoked-token'),
    ).resolves.toBeNull();
  });

  it('revokes the current session on logout', async () => {
    const fake = createDatabase();
    service = new AuthService(fake.database as never);

    await service.logout('session-token');

    expect(fake.database.updateTable).toHaveBeenCalledWith('auth.sessions');
  });
});
