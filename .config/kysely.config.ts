import { PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { defineConfig } from 'kysely-ctl';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required for Kysely migrations');
}

export default defineConfig({
  dialect: new PostgresDialect({
    pool: new Pool({
      connectionString: process.env.DATABASE_URL,
    }),
  }),
  migrations: {
    migrationFolder: '../src/database/migrations',
  },
  plugins: [],
  seeds: {
    seedFolder: '../src/database/seeds',
  },
});
