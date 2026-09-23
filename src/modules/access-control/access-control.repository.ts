import { Inject, Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { DATABASE } from '../../database/database.module';
import type { DB } from '../../database/db';
import { PERMISSION_CATALOG, type PermissionKey } from './permission-catalog';
import type { AccessContext } from './access-control.types';

const KNOWN_PERMISSION_KEYS = new Set<string>(
  PERMISSION_CATALOG.map(
    ({ module_key, action_key }) => `${module_key}.${action_key}`,
  ),
);

@Injectable()
export class AccessControlRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DB>) {}

  async findAccessContext(userId: string): Promise<AccessContext | null> {
    const account = await this.db
      .selectFrom('auth.users as u')
      .innerJoin('auth.roles as r', 'r.id', 'u.role_id')
      .select([
        'u.id as user_id',
        'u.is_active as account_active',
        'r.id as role_id',
        'r.code as role_code',
        'r.role_name as role_name',
        'r.is_system as role_is_system',
        'r.is_active as role_is_active',
      ])
      .where('u.id', '=', userId)
      .executeTakeFirst();
    if (!account) return null;

    const [grants, branches] = await Promise.all([
      this.db
        .selectFrom('auth.role_permissions as rp')
        .innerJoin('auth.permissions as p', 'p.id', 'rp.permission_id')
        .where('rp.role_id', '=', account.role_id)
        .select(['p.module_key', 'p.action_key'])
        .execute(),
      this.db
        .selectFrom('auth.branch_users as bu')
        .innerJoin('branches as b', 'b.id', 'bu.branch_id')
        .where('bu.user_id', '=', userId)
        .where('b.status', '=', 'active')
        .select('bu.branch_id')
        .execute(),
    ]);

    const permissions = grants
      .map(({ module_key, action_key }) => `${module_key}.${action_key}`)
      .filter((key): key is PermissionKey => KNOWN_PERMISSION_KEYS.has(key));

    return {
      userId: account.user_id,
      accountActive: account.account_active,
      role: {
        id: account.role_id,
        code: account.role_code,
        name: account.role_name,
        isSystem: account.role_is_system,
        isActive: account.role_is_active,
      },
      permissions,
      branchIds: branches.map(({ branch_id }) => branch_id),
    };
  }
}
