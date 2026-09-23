import '../src/config/load-env';

import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';

import type { DB } from '../src/database/db';
import { hashPassword } from '../src/modules/auth/password-hashing';

type AccountInput = {
  email: string;
  fullName: string;
  contactNumber: string;
  password: string;
};

type Arguments = {
  email?: string;
  fullName?: string;
  contactNumber?: string;
  passwordStdin: boolean;
};

async function readPasswordFromStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks)
    .toString('utf8')
    .replace(/\r?\n$/, '');
}

function printUsage(): void {
  console.log(`Create a COMS account with an Argon2id password hash.

Usage:
  pnpm run account:create
  pnpm run account:create -- --email staff@example.com --full-name "Staff User" --contact-number "09171234567"
  printf '%s\\n' 'a long password' | pnpm run account:create -- --password-stdin

Options:
  --email <email>
  --full-name <name>
  --contact-number <number>
  --password-stdin       Read the password from stdin instead of prompting.
  --help
`);
}

function parseArguments(argv: string[]): Arguments {
  const args: Arguments = { passwordStdin: false };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      printUsage();
      process.exit(0);
    }
    if (argument === '--password-stdin') {
      args.passwordStdin = true;
      continue;
    }

    const option = {
      '--email': 'email',
      '--full-name': 'fullName',
      '--contact-number': 'contactNumber',
    } as const;
    const key = option[argument as keyof typeof option];
    if (!key) {
      throw new Error(`Unknown option: ${argument}`);
    }

    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`${argument} requires a value`);
    }
    args[key] = value;
    index += 1;
  }

  return args;
}

async function promptForAccount(args: Arguments): Promise<AccountInput> {
  const prompts = createInterface({ input, output });
  try {
    const email = args.email ?? (await prompts.question('Email: '));
    const fullName = args.fullName ?? (await prompts.question('Full name: '));
    const contactNumber =
      args.contactNumber ?? (await prompts.question('Contact number: '));

    if (args.passwordStdin) {
      prompts.close();
      const password = await readPasswordFromStdin();
      return { email, fullName, contactNumber, password };
    }

    const password = await prompts.question('Password: ');
    return { email, fullName, contactNumber, password };
  } finally {
    prompts.close();
  }
}

function normalizeAndValidate(input: AccountInput): AccountInput {
  const email = input.email.trim().toLowerCase();
  const fullName = input.fullName.trim();
  const contactNumber = input.contactNumber.trim();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) {
    throw new Error(
      'Email must be a valid address no longer than 320 characters.',
    );
  }
  if (fullName.length < 2 || fullName.length > 160) {
    throw new Error('Full name must be between 2 and 160 characters.');
  }
  if (contactNumber.length < 7 || contactNumber.length > 30) {
    throw new Error('Contact number must be between 7 and 30 characters.');
  }
  if (input.password.length < 12 || input.password.length > 128) {
    throw new Error('Password must be between 12 and 128 characters.');
  }

  return { email, fullName, contactNumber, password: input.password };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505'
  );
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const account = normalizeAndValidate(await promptForAccount(args));
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required. Add it to coms-api/.env first.');
  }

  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const db = new Kysely<DB>({
    dialect: new PostgresDialect({ pool }),
  });

  try {
    const noAccessRole = await db
      .selectFrom('auth.roles')
      .select('id')
      .where('code', '=', 'NO_ACCESS')
      .where('is_active', '=', true)
      .executeTakeFirst();

    if (!noAccessRole) {
      throw new Error(
        'The NO_ACCESS role is missing. Apply the access-control migration first.',
      );
    }

    const existing = await db
      .selectFrom('auth.users')
      .select(['email', 'contact_number'])
      .where((expressionBuilder) =>
        expressionBuilder.or([
          expressionBuilder('email', '=', account.email),
          expressionBuilder('contact_number', '=', account.contactNumber),
        ]),
      )
      .executeTakeFirst();

    if (existing) {
      throw new Error(
        'An account with that email or contact number already exists.',
      );
    }

    const hashedPassword = await hashPassword(account.password);
    const user = await db
      .insertInto('auth.users')
      .values({
        email: account.email,
        full_name: account.fullName,
        contact_number: account.contactNumber,
        hashed_password: hashedPassword,
        role_id: noAccessRole.id,
      })
      .returning(['id', 'email', 'full_name', 'contact_number'])
      .executeTakeFirstOrThrow();

    console.log(`Created account for ${user.email} (${user.id}).`);
    console.log('The password was stored as an Argon2id hash.');
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new Error(
        'An account with that email or contact number already exists.',
      );
    }
    throw error;
  } finally {
    await db.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
