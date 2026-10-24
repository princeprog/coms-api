import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely, type Transaction } from 'kysely';
import { DATABASE } from '../../database/database.module';
import type { DB } from '../../database/db';
import { recordAudit, type AuditEventInput } from '../audit/audit-recorder';

type Connection = Kysely<DB> | Transaction<DB>;

@Injectable()
export class AuthRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DB>) {}

  transaction<T>(work: (trx: Transaction<DB>) => Promise<T>) {
    return this.db.transaction().execute(work);
  }
  audit(event: AuditEventInput, db: Connection = this.db) {
    return recordAudit(db, event);
  }
  findByEmail(email: string) {
    return this.db
      .selectFrom('coms_auth.users')
      .selectAll()
      .where('email', '=', email)
      .executeTakeFirst();
  }
  findUser(id: string, db: Connection = this.db) {
    return db
      .selectFrom('coms_auth.users')
      .select([
        'id',
        'email',
        'full_name',
        'contact_number',
        'must_change_password',
      ])
      .where('id', '=', id)
      .executeTakeFirst();
  }
  findUserForSession(id: string, db: Connection = this.db, lock = false) {
    const query = db
      .selectFrom('coms_auth.users')
      .select([
        'id',
        'email',
        'full_name',
        'contact_number',
        'is_active',
        'must_change_password',
        'hashed_password',
      ])
      .where('id', '=', id);
    return (lock ? query.forUpdate() : query).executeTakeFirst();
  }
  updatePassword(trx: Transaction<DB>, userId: string, hash: string) {
    return trx
      .updateTable('coms_auth.users')
      .set({
        hashed_password: hash,
        must_change_password: false,
        password_changed_at: sql<Date>`now()`,
        updated_at: sql<Date>`now()`,
      })
      .where('id', '=', userId)
      .execute();
  }
  revokeUserFamilies(trx: Transaction<DB>, userId: string) {
    return trx
      .updateTable('coms_auth.token_families')
      .set({ revoked_at: sql<Date>`clock_timestamp()` })
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null)
      .execute();
  }
  createFamily(trx: Transaction<DB>, userId: string, ttl: number) {
    return trx
      .insertInto('coms_auth.token_families')
      .values({
        user_id: userId,
        expires_at: new Date(Date.now() + ttl * 1000),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }
  findFamily(id: string, db: Connection = this.db, lock = false) {
    const query = db
      .selectFrom('coms_auth.token_families')
      .selectAll()
      .where('id', '=', id);
    return (lock ? query.forUpdate() : query).executeTakeFirst();
  }
  findRefresh(trx: Transaction<DB>, hash: string) {
    return trx
      .selectFrom('coms_auth.refresh_tokens')
      .selectAll()
      .where('token_hash', '=', hash)
      .forUpdate()
      .executeTakeFirst();
  }
  insertRefresh(
    db: Connection,
    id: string,
    familyId: string,
    hash: string,
    expires: Date,
  ) {
    return db
      .insertInto('coms_auth.refresh_tokens')
      .values({
        id,
        family_id: familyId,
        token_hash: hash,
        expires_at: expires,
      })
      .execute();
  }
  consumeRefresh(trx: Transaction<DB>, id: string, successorId: string) {
    return trx
      .updateTable('coms_auth.refresh_tokens')
      .set({
        consumed_at: sql<Date>`clock_timestamp()`,
        replaced_by_id: successorId,
      })
      .where('id', '=', id)
      .execute();
  }
  revokeFamily(id: string, db: Connection = this.db) {
    return db
      .updateTable('coms_auth.token_families')
      .set({ revoked_at: sql<Date>`clock_timestamp()` })
      .where('id', '=', id)
      .where('revoked_at', 'is', null)
      .execute();
  }
}
