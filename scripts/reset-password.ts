import '../src/config/load-env';

import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';

import type { DB } from '../src/database/db';
import { hashPassword } from '../src/modules/auth/password-hashing';
import {
  generateTemporaryPassword,
  validateNewPassword,
} from '../src/modules/auth/temporary-password';

// Recovery for a locked-out account (including the only Super Admin) by
// someone with server access. The user must change the password at sign-in.
function parse(argv: string[]) {
  const args: { email?: string; generate: boolean } = { generate: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') continue;
    if (argument === '--generate') args.generate = true;
    else if (argument === '--email') args.email = argv[(index += 1)];
    else if (argument === '--help' || argument === '-h') {
      console.log(`Reset a COMS account password.

Usage:
  pnpm run account:reset-password -- --email admin@example.com
  pnpm run account:reset-password -- --email admin@example.com --generate

The account must change the temporary password at its next sign-in, and all
of its sessions end immediately.`);
      process.exit(0);
    } else throw new Error(`Unknown option: ${argument}`);
  }
  return args;
}

async function main() {
  const args = parse(process.argv.slice(2));
  const prompts = createInterface({ input, output });
  let email: string;
  let password: string;
  try {
    email = (args.email ?? (await prompts.question('Email: ')))
      .trim()
      .toLowerCase();
    password = args.generate
      ? generateTemporaryPassword()
      : await prompts.question('Temporary password (12-128 characters): ');
  } finally {
    prompts.close();
  }
  if (!validateNewPassword(password))
    throw new Error('Password must be between 12 and 128 characters.');
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl)
    throw new Error('DATABASE_URL is required. Add it to coms-api/.env first.');
  const db = new Kysely<DB>({
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString: databaseUrl, max: 1 }),
    }),
  });
  try {
    const hash = await hashPassword(password);
    const user = await db.transaction().execute(async (trx) => {
      const updated = await trx
        .updateTable('auth.users')
        .set({
          hashed_password: hash,
          must_change_password: true,
          password_changed_at: sql<Date>`now()`,
          updated_at: sql<Date>`now()`,
        })
        .where('email', '=', email)
        .returning(['id', 'email'])
        .executeTakeFirst();
      if (!updated) throw new Error('No account uses that email.');
      await trx
        .updateTable('auth.token_families')
        .set({ revoked_at: sql<Date>`clock_timestamp()` })
        .where('user_id', '=', updated.id)
        .where('revoked_at', 'is', null)
        .execute();
      return updated;
    });
    console.log(`Password reset for ${user.email}. All sessions were ended.`);
    if (args.generate) console.log(`Temporary password: ${password}`);
    console.log('The account must choose a new password at its next sign-in.');
  } finally {
    await db.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
