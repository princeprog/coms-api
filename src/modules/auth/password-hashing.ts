import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';

type Argon2Options = {
  memory: number;
  passes: number;
  parallelism: number;
  tagLength: number;
};

const PASSWORD_HASH_OPTIONS: Argon2Options = {
  memory: 19_456,
  passes: 2,
  parallelism: 1,
  tagLength: 32,
};

if (typeof argon2 !== 'function') {
  throw new Error(
    'COMS API password hashing requires Node.js 24.7.0 or newer.',
  );
}

const PASSWORD_HASH_PATTERN =
  /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;
const MAX_MEMORY_COST = 65_536;
const MAX_PASSES = 10;
const MAX_PARALLELISM = 4;

type ParsedPasswordHash = {
  memory: number;
  passes: number;
  parallelism: number;
  salt: Buffer;
  digest: Buffer;
};

function derivePasswordHash(
  password: string,
  salt: Buffer,
  options: Argon2Options,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2(
      'argon2id',
      {
        message: Buffer.from(password, 'utf8'),
        nonce: salt,
        ...options,
      },
      (error, derivedKey) => {
        if (error) reject(error);
        else resolve(derivedKey);
      },
    );
  });
}

function decodeBase64(value: string): Buffer | null {
  const decoded = Buffer.from(value, 'base64');
  return decoded.toString('base64').replace(/=+$/, '') === value
    ? decoded
    : null;
}

function parsePasswordHash(value: unknown): ParsedPasswordHash | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  const match = PASSWORD_HASH_PATTERN.exec(value);
  if (!match) return null;

  const memory = Number(match[1]);
  const passes = Number(match[2]);
  const parallelism = Number(match[3]);
  if (
    !Number.isSafeInteger(memory) ||
    memory < 8 * parallelism ||
    memory > MAX_MEMORY_COST ||
    !Number.isSafeInteger(passes) ||
    passes < 1 ||
    passes > MAX_PASSES ||
    !Number.isSafeInteger(parallelism) ||
    parallelism < 1 ||
    parallelism > MAX_PARALLELISM
  )
    return null;

  const salt = decodeBase64(match[4]);
  const digest = decodeBase64(match[5]);
  if (!salt || salt.length < 8 || salt.length > 1024) return null;
  if (!digest || digest.length < 4 || digest.length > 64) return null;

  return { memory, passes, parallelism, salt, digest };
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const digest = await derivePasswordHash(
    password,
    salt,
    PASSWORD_HASH_OPTIONS,
  );
  const saltText = salt.toString('base64').replace(/=+$/, '');
  const digestText = digest.toString('base64').replace(/=+$/, '');

  return `$argon2id$v=19$m=${PASSWORD_HASH_OPTIONS.memory},t=${PASSWORD_HASH_OPTIONS.passes},p=${PASSWORD_HASH_OPTIONS.parallelism}$${saltText}$${digestText}`;
}

export async function verifyPassword(
  encodedHash: unknown,
  password: string,
): Promise<boolean> {
  const parsed = parsePasswordHash(encodedHash);
  if (!parsed) return false;

  const digest = await derivePasswordHash(password, parsed.salt, {
    memory: parsed.memory,
    passes: parsed.passes,
    parallelism: parsed.parallelism,
    tagLength: parsed.digest.length,
  });

  return timingSafeEqual(digest, parsed.digest);
}
