import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { sql, type Kysely, type Transaction } from 'kysely';
import { DATABASE } from '../../database/database.module';
import type { DB } from '../../database/db';

type RoleId = string;
type RoleRow = {
  id: RoleId;
  code: string;
  role_name: string;
  is_system: boolean;
  is_active: boolean;
};

@Injectable()
export class RolesRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DB>) {}

  async list() {
    const [roles, grants] = await Promise.all([
      this.db
        .selectFrom('auth.roles')
        .select(['id', 'code', 'role_name', 'is_system', 'is_active'])
        .orderBy('role_name')
        .execute(),
      this.db
        .selectFrom('auth.role_permissions as rp')
        .innerJoin('auth.permissions as p', 'p.id', 'rp.permission_id')
        .select(['rp.role_id', 'p.module_key', 'p.action_key'])
        .execute(),
    ]);
    const permissionsByRole = new Map<string, string[]>();
    for (const grant of grants) {
      const keys = permissionsByRole.get(grant.role_id) ?? [];
      keys.push(`${grant.module_key}.${grant.action_key}`);
      permissionsByRole.set(grant.role_id, keys);
    }
    return roles.map((role) => ({
      ...role,
      permission_keys: permissionsByRole.get(role.id) ?? [],
    }));
  }

  findById(id: RoleId) {
    return this.db
      .selectFrom('auth.roles')
      .select(['id', 'code', 'is_system'])
      .where('id', '=', id)
      .executeTakeFirst();
  }

  async create(input: {
    code: string;
    role_name: string;
    permission_keys: string[];
  }) {
    try {
      return await this.db.transaction().execute(async (trx) => {
        const role = await trx
          .insertInto('auth.roles')
          .values({
            code: input.code,
            role_name: input.role_name.trim(),
            is_system: false,
            is_active: true,
          })
          .returning(['id', 'code', 'role_name', 'is_system', 'is_active'])
          .executeTakeFirstOrThrow();
        await this.writeGrants(trx, role.id, input.permission_keys);
        return { ...role, permission_keys: input.permission_keys };
      });
    } catch (error) {
      if (this.isUniqueViolation(error))
        throw new ConflictException('Role code or name already exists');
      throw error;
    }
  }

  async updateName(id: RoleId, roleName: string) {
    try {
      return await this.db.transaction().execute(async (trx) => {
        const role = await this.lockRole(trx, id);
        if (!role) return null;
        this.assertCustomRole(role);
        return trx
          .updateTable('auth.roles')
          .set({ role_name: roleName.trim(), updated_at: sql<Date>`now()` })
          .where('id', '=', id)
          .returning(['id', 'code', 'role_name', 'is_system', 'is_active'])
          .executeTakeFirst();
      });
    } catch (error) {
      if (this.isUniqueViolation(error))
        throw new ConflictException('Role name already exists');
      throw error;
    }
  }

  async replacePermissions(id: RoleId, permissionKeys: string[]) {
    return this.db.transaction().execute(async (trx) => {
      const role = await this.lockRole(trx, id);
      if (!role) return null;
      this.assertCustomRole(role);
      await this.writeGrants(trx, id, permissionKeys);
      return { id, permission_keys: permissionKeys };
    });
  }

  async deactivate(id: RoleId) {
    return this.db.transaction().execute(async (trx) => {
      const role = await this.lockRole(trx, id);
      if (!role) return null;
      this.assertCustomRole(role);
      const assigned = await trx
        .selectFrom('auth.users')
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .where('role_id', '=', id)
        .executeTakeFirstOrThrow();
      if (Number(assigned.count) > 0)
        throw new ConflictException(
          'Reassign staff from this role before deactivating it',
        );
      return trx
        .updateTable('auth.roles')
        .set({ is_active: false, updated_at: sql<Date>`now()` })
        .where('id', '=', id)
        .returning(['id', 'code', 'role_name', 'is_system', 'is_active'])
        .executeTakeFirst();
    });
  }

  private async lockRole(
    trx: Transaction<DB>,
    id: RoleId,
  ): Promise<RoleRow | undefined> {
    return trx
      .selectFrom('auth.roles')
      .select(['id', 'code', 'role_name', 'is_system', 'is_active'])
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
  }

  private assertCustomRole(role: RoleRow): void {
    if (role.is_system)
      throw new ForbiddenException('System roles are protected');
  }

  private async writeGrants(
    trx: Transaction<DB>,
    roleId: RoleId,
    permissionKeys: string[],
  ): Promise<void> {
    const permissionIds = permissionKeys.length
      ? await trx
          .selectFrom('auth.permissions')
          .select(['id', 'module_key', 'action_key'])
          .execute()
      : [];
    const selected = permissionIds.filter((permission) =>
      permissionKeys.includes(
        `${permission.module_key}.${permission.action_key}`,
      ),
    );
    if (selected.length !== permissionKeys.length)
      throw new ConflictException('Permission catalog is out of sync');
    await trx
      .deleteFrom('auth.role_permissions')
      .where('role_id', '=', roleId)
      .execute();
    if (selected.length)
      await trx
        .insertInto('auth.role_permissions')
        .values(
          selected.map(({ id }) => ({ role_id: roleId, permission_id: id })),
        )
        .execute();
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === '23505'
    );
  }
}
