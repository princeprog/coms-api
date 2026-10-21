import { CompiledQuery, Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { currentAuditActor } from '../common/utils/audit-context';
import type { DB } from './db';

// Every reserved connection carries the request's actor (or none) so audit
// triggers can attribute changes. Session-level, so always overwritten.
export function createDatabase(connectionString: string, max = 10) {
  return new Kysely<DB>({
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString, max }),
      onReserveConnection: async (connection) => {
        await connection.executeQuery(
          CompiledQuery.raw("SELECT set_config('coms.actor_id', $1, false)", [
            currentAuditActor() ?? '',
          ]),
        );
      },
    }),
  });
}
