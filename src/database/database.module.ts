import { Global, Module, OnApplicationShutdown } from '@nestjs/common';
import { createDatabase } from './create-database';

export const DATABASE = Symbol('DATABASE');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required');
}

const database = createDatabase(
  process.env.DATABASE_URL,
  Number(process.env.DB_POOL_MAX ?? 10),
);

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
