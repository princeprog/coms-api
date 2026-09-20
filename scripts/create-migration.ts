import { promises as fs } from 'node:fs';
import * as path from 'node:path';

// Folder where migrations are stored
const migrationsDir = path.join(process.cwd(), 'src/database/migrations');

// Get migration name from CLI
const name = process.argv[2];

if (!name) {
  console.error('❌ Please provide a migration name.');
  console.error('Usage: pnpm run migrate:create add_users_table');
  process.exit(1);
}

// Convert camelCase or PascalCase to snake_case
function toSnakeCase(str: string): string {
  return str
    .replace(/([a-z])([A-Z])/g, '$1_$2') // camelCase to snake_case
    .replace(/\s+/g, '_') // spaces to underscores
    .replace(/-+/g, '_') // hyphens to underscores
    .toLowerCase()
    .replace(/^_+|_+$/g, ''); // remove leading/trailing underscores
}

// Format timestamp as YYYYMMDDHHMMSS
function getTimestamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    now.getFullYear() +
    pad(now.getMonth() + 1) +
    pad(now.getDate()) +
    pad(now.getHours()) +
    pad(now.getMinutes()) +
    pad(now.getSeconds())
  );
}

// Kysely migration template
const template = `import type { Kysely } from 'kysely'

// \`any\` is required here since migrations should be frozen in time. alternatively, keep a "snapshot" db interface.
export async function up(db: Kysely<any>): Promise<void> {
	// up migration code goes here...
	// note: up migrations are mandatory. you must implement this function.
	// For more info, see: https://kysely.dev/docs/migrations
}

// \`any\` is required here since migrations should be frozen in time. alternatively, keep a "snapshot" db interface.
export async function down(db: Kysely<any>): Promise<void> {
	// down migration code goes here...
	// note: down migrations are optional. you can safely delete this function.
	// For more info, see: https://kysely.dev/docs/migrations
}
`;

const isDirectFilename = /^\d{12,14}_/.test(name);
let filename: string;

if (isDirectFilename) {
  filename = name.endsWith('.ts') ? name : `${name}.ts`;
} else {
  const timestamp = getTimestamp();
  const snakeName = toSnakeCase(name);
  filename = `${timestamp}_${snakeName}.ts`;
}

const filePath = path.join(migrationsDir, filename);

async function createMigration(): Promise<void> {
  try {
    await fs.mkdir(migrationsDir, { recursive: true });
    await fs.writeFile(filePath, template);
    console.log(`✅ Migration created: src/database/migrations/${filename}`);
  } catch (err) {
    console.error('❌ Failed to create migration:', err);
    process.exit(1);
  }
}

createMigration();
