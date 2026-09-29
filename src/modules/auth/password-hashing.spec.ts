import { argon2 } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './password-hashing';

function deriveArgon2id(
  message: Buffer,
  nonce: Buffer,
  secret: Buffer,
  associatedData: Buffer,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2(
      'argon2id',
      {
        message,
        nonce,
        secret,
        associatedData,
        memory: 32,
        passes: 3,
        parallelism: 4,
        tagLength: 32,
      },
      (error, tag) => {
        if (error) reject(error);
        else resolve(tag);
      },
    );
  });
}

describe('password hashing', () => {
  it('matches the RFC 9106 Argon2id test vector supported by the runtime', async () => {
    const tag = await deriveArgon2id(
      Buffer.alloc(32, 1),
      Buffer.alloc(16, 2),
      Buffer.alloc(8, 3),
      Buffer.alloc(12, 4),
    );

    expect(tag.toString('hex')).toBe(
      '0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659',
    );
  });

  it('creates an Argon2id PHC hash with the existing work factors', async () => {
    const hash = await hashPassword('COMS password test');

    expect(hash).toMatch(
      /^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/,
    );
  });

  it('verifies the correct password and rejects an incorrect one', async () => {
    const hash = await hashPassword('COMS password test');

    await expect(verifyPassword(hash, 'COMS password test')).resolves.toBe(
      true,
    );
    await expect(verifyPassword(hash, 'another password')).resolves.toBe(false);
  });

  it('verifies an existing standard Argon2id PHC hash', async () => {
    const existingHash =
      '$argon2id$v=19$m=19456,t=2,p=1$Q09NUy1hcmdvbjItc2FsdA$c640PKX2TPXmzo/tOVDLNefYH5D3l2o6ziN00ivxE0I';

    await expect(
      verifyPassword(existingHash, 'COMS compatibility fixture password'),
    ).resolves.toBe(true);
  });

  it('rejects malformed or resource-excessive stored hashes', async () => {
    await expect(verifyPassword('not a PHC hash', 'password')).resolves.toBe(
      false,
    );
    await expect(verifyPassword('x'.repeat(2049), 'password')).resolves.toBe(
      false,
    );
    await expect(
      verifyPassword(
        '$argon2id$v=19$m=999999999,t=2,p=1$AgICAgICAgICAgICAgICAg$AAAA',
        'password',
      ),
    ).resolves.toBe(false);
  });
});
