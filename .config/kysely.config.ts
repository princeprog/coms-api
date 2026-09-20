import {
  DummyDriver,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { defineConfig } from 'kysely-ctl';

export default defineConfig({
  // replace me with a real dialect instance OR a dialect name + `dialectConfig` prop.
  dialect: new PostgresDialect({
    pool: new Pool({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
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
