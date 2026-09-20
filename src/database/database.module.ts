import { Global, Module, OnApplicationShutdown } from '@nestjs/common';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import type { DB } from './db';

export const DATABASE = Symbol('DATABASE');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DB_POOL_MAX ?? 10),
});

const database = new Kysely<DB>({
  dialect: new PostgresDialect({ pool }),
});

@Global()
@Module({
  providers: [
    {
      provide: DATABASE,
      useValue: database,
    },
  ],
  exports: [DATABASE],
})
export class DatabaseModule implements OnApplicationShutdown {
  async onApplicationShutdown(): Promise<void> {
    await database.destroy();
  }
}
