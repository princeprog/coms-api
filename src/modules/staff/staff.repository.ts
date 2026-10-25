import { containsSearchPattern } from '../../common/utils/list-filters';
import {
  paginatedResult,
  paginationOffset,
} from '../../common/utils/pagination';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  InternalServerErrorException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { sql, type Kysely, type Transaction } from 'kysely';
import { DATABASE } from '../../database/database.module';
import { listDiff, recordAudit } from '../audit/audit-recorder';
import { clearStaffSchedules } from '../schedules/schedule-support';
import type { DB } from '../../database/db';

type Connection = Kysely<DB> | Transaction<DB>;

@Injectable()
export class StaffRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DB>) {}

  async list(
    page: number,
    pageSize: number,
    search?: string,
    branchId?: string,
    visibleBranchIds?: string[],
    status?: 'active' | 'inactive' | 'unassigned',
  ) {
    const pattern = search?.trim() ? containsSearchPattern(search) : undefined;
    let records = this.db
      .selectFrom('coms_auth.users as u')
      .leftJoin('coms_auth.roles as r', 'r.id', 'u.role_id')
      .select([
        'u.id',
        'u.email',
        'u.full_name',
        'u.contact_number',
        'u.is_active',
        'u.role_id as role_id',
        'r.code as role_code',
        'r.role_name as role_name',
      ])
      .orderBy('u.full_name')
      .limit(pageSize)
      .offset(paginationOffset({ page, page_size: pageSize }));
    let count = this.db
      .selectFrom('coms_auth.users as u')
      .select((eb) => eb.fn.countAll<number>().as('total'));
    if (branchId) {
      const branchUserIds = this.db
        .selectFrom('coms_auth.branch_users as bu')
        .innerJoin('branches as b', 'b.id', 'bu.branch_id')
        .select('bu.user_id')
        .where('bu.branch_id', '=', branchId)
        .where('b.status', '=', 'active');
      records = records.where('u.id', 'in', branchUserIds);
      count = count.where('u.id', 'in', branchUserIds);
    }
    if (pattern) {
      records = records.where((eb) =>
        eb.or([
          eb('u.email', 'ilike', pattern),
          eb('u.full_name', 'ilike', pattern),
          eb('u.contact_number', 'ilike', pattern),
        ]),
      );
      count = count.where((eb) =>
        eb.or([
          eb('u.email', 'ilike', pattern),
          eb('u.full_name', 'ilike', pattern),
          eb('u.contact_number', 'ilike', pattern),
        ]),
      );
    }
    if (status === 'active' || status === 'inactive') {
      const isActive = status === 'active';
      records = records.where('u.is_active', '=', isActive);
      count = count.where('u.is_active', '=', isActive);
    } else if (status === 'unassigned') {
      records = records.where('u.role_id', 'is', null);
      count = count.where('u.role_id', 'is', null);
    }
    const [staff, total] = await Promise.all([
      records.execute(),
      count.executeTakeFirstOrThrow(),
    ]);
    const branchesByUser = await this.activeBranchesForUsers(
      staff.map(({ id }) => id),
    );
    return paginatedResult(
      staff.map((member) => ({
        ...member,
        branch_ids: (branchesByUser.get(member.id) ?? []).filter(
          (id) => !visibleBranchIds || visibleBranchIds.includes(id),
        ),
      })),
      Number(total.total),
      { page, page_size: pageSize },
    );
  }

  async findById(
    id: string,
    connection: Connection = this.db,
    requiredBranchId?: string,
  ) {
    let memberQuery = connection
      .selectFrom('coms_auth.users as u')
      .leftJoin('coms_auth.roles as r', 'r.id', 'u.role_id')
      .select([
        'u.id',
        'u.email',
        'u.full_name',
        'u.contact_number',
        'u.is_active',
        'u.role_id as role_id',
        'r.code as role_code',
        'r.role_name as role_name',
      ])
      .where('u.id', '=', id);
    if (requiredBranchId) {
      const usersInBranch = connection
        .selectFrom('coms_auth.branch_users as bu')
        .innerJoin('branches as b', 'b.id', 'bu.branch_id')
        .select('bu.user_id')
        .where('bu.branch_id', '=', requiredBranchId)
        .where('b.status', '=', 'active');
      memberQuery = memberQuery.where('u.id', 'in', usersInBranch);
    }
    const member = await memberQuery.executeTakeFirst();
    if (!member) return null;
    const branchesByUser = await this.activeBranchesForUsers([id], connection);
    return { ...member, branch_ids: branchesByUser.get(id) ?? [] };
  }

  findByIdInBranch(id: string, branchId?: string) {
    return this.findById(id, this.db, branchId);
  }

  async create(input: {
    email: string;
    full_name: string;
    contact_number: string;
    hashed_password: string;
    role_id: string | null;
    branch_ids: string[];
  }) {
    try {
      return await this.db.transaction().execute(async (trx) => {
        if (input.role_id !== null)
          await this.assertAssignableRole(trx, input.role_id);
        await this.assertActiveBranches(trx, input.branch_ids);
        const user = await trx
          .insertInto('coms_auth.users')
          .values({
            email: input.email,
            full_name: input.full_name,
            contact_number: input.contact_number,
            hashed_password: input.hashed_password,
            role_id: input.role_id,
            is_active: true,
          })
          .returning([
            'id',
            'email',
            'full_name',
            'contact_number',
            'is_active',
          ])
          .executeTakeFirstOrThrow();
        if (input.branch_ids.length)
          await trx
            .insertInto('coms_auth.branch_users')
            .values(
              input.branch_ids.map((branch_id) => ({
                user_id: user.id,
                branch_id,
              })),
            )
            .execute();
        const result = await this.findById(user.id, trx);
        if (!result)
          throw new InternalServerErrorException(
            'Created account could not be loaded',
          );
        return result;
      });
    } catch (error) {
      if (this.isUniqueViolation(error))
        throw new ConflictException(
          'An account with that email or contact number already exists',
        );
      throw error;
    }
  }

  async update(
    id: string,
    patch: { email?: string; full_name?: string; contact_number?: string },
    branchId?: string,
  ) {
    try {
      return await this.db.transaction().execute(async (trx) => {
        await this.lockUser(trx, id);
        if (branchId) await this.assertUserInBranch(trx, id, branchId);
        await trx
          .updateTable('coms_auth.users')
          .set({ ...patch, updated_at: sql<Date>`now()` })
          .where('id', '=', id)
          .execute();
        return this.findById(id, trx);
      });
    } catch (error) {
      if (this.isUniqueViolation(error))
        throw new ConflictException(
          'An account with that email or contact number already exists',
        );
      throw error;
    }
  }

  async assignRole(
    id: string,
    roleId: string | null,
    actorIsSuperAdmin: boolean,
    branchId?: string,
  ) {
    return this.db.transaction().execute(async (trx) => {
      await this.lockUser(trx, id);
      if (branchId) await this.assertUserInBranch(trx, id, branchId);
      await this.assertProtectedAdminTarget(trx, id, actorIsSuperAdmin);
      if (roleId !== null) await this.assertAssignableRole(trx, roleId);
      const changed = await trx
        .updateTable('coms_auth.users')
        .set({ role_id: roleId, updated_at: sql<Date>`now()` })
        .where('id', '=', id)
        .returning(['id'])
        .executeTakeFirst();
      if (!changed) throw new NotFoundException('Staff account not found');
      return this.findById(id, trx);
    });
  }

  async assignBranches(
    id: string,
    branchIds: string[],
    actorBranchIds?: string[],
    scopeBranchId?: string,
  ) {
    return this.db.transaction().execute(async (trx) => {
      await this.lockUser(trx, id);
      if (scopeBranchId) {
        await this.assertActiveBranches(trx, [scopeBranchId]);
        const existingBranchIds =
          (await this.activeBranchesForUsers([id], trx)).get(id) ?? [];
        if (
          existingBranchIds.length > 0 &&
          !existingBranchIds.includes(scopeBranchId)
        )
          throw new NotFoundException('Staff account not found');
      }
      await this.assertActiveBranches(trx, branchIds);
      let assignedBranchIds = branchIds;
      if (actorBranchIds) {
        const existingBranchIds =
          (await this.activeBranchesForUsers([id], trx)).get(id) ?? [];
        const outsideScope = existingBranchIds.filter(
          (branchId) => !actorBranchIds.includes(branchId),
        );
        assignedBranchIds = [...new Set([...outsideScope, ...branchIds])];
      }
      const previous = await trx
        .selectFrom('coms_auth.branch_users')
        .select('branch_id')
        .where('user_id', '=', id)
        .execute();
      await trx
        .deleteFrom('coms_auth.branch_users')
        .where('user_id', '=', id)
        .execute();
      if (assignedBranchIds.length)
        await trx
          .insertInto('coms_auth.branch_users')
          .values(
            assignedBranchIds.map((branch_id) => ({
              user_id: id,
              branch_id,
            })),
          )
          .execute();
      const { added, removed } = listDiff(
        previous.map(({ branch_id }) => branch_id),
        assignedBranchIds,
      );
      await clearStaffSchedules(trx, id, removed);
      if (added.length || removed.length) {
        const names = new Map(
          (
            await trx
              .selectFrom('branches')
              .select(['id', 'branch_name'])
              .where('id', 'in', [...added, ...removed])
              .execute()
          ).map((branch) => [branch.id, branch.branch_name]),
        );
        const user = await trx
          .selectFrom('coms_auth.users')
          .select('full_name')
          .where('id', '=', id)
          .executeTakeFirst();
        const label = (ids: string[]) => ids.map((b) => names.get(b) ?? b);
        await recordAudit(trx, {
          action: 'staff.branches_updated',
          entityType: 'staff',
          entityId: id,
          entityLabel: user?.full_name ?? null,
          metadata: { added: label(added), removed: label(removed) },
        });
      }
      return this.findById(id, trx);
    });
  }

  async deactivate(id: string, actorIsSuperAdmin: boolean, branchId?: string) {
    return this.db.transaction().execute(async (trx) => {
      await this.lockUser(trx, id);
      if (branchId) await this.assertUserInBranch(trx, id, branchId);
      await this.assertProtectedAdminTarget(trx, id, actorIsSuperAdmin);
      const member = await trx
        .updateTable('coms_auth.users')
        .set({ is_active: false, updated_at: sql<Date>`now()` })
        .where('id', '=', id)
        .returning(['id'])
        .executeTakeFirst();
      if (!member) throw new NotFoundException('Staff account not found');
      await clearStaffSchedules(trx, id);
      await this.revokeSessions(trx, id);
      return this.findById(id, trx);
    });
  }

  async resetPassword(
    id: string,
    hash: string,
    actorIsSuperAdmin: boolean,
    branchId?: string,
  ) {
    return this.db.transaction().execute(async (trx) => {
      await this.lockUser(trx, id);
      if (branchId) await this.assertUserInBranch(trx, id, branchId);
      await this.assertProtectedAdminTarget(trx, id, actorIsSuperAdmin);
      const member = await trx
        .updateTable('coms_auth.users')
        .set({
          hashed_password: hash,
          must_change_password: true,
          password_changed_at: sql<Date>`now()`,
          updated_at: sql<Date>`now()`,
        })
        .where('id', '=', id)
        .returning(['id', 'full_name', 'email'])
        .executeTakeFirst();
      if (!member) throw new NotFoundException('Staff account not found');
      await this.revokeSessions(trx, id);
      await recordAudit(trx, {
        action: 'staff.password_reset',
        entityType: 'staff',
        entityId: member.id,
        entityLabel: member.full_name,
      });
      return member;
    });
  }

  private revokeSessions(trx: Transaction<DB>, userId: string) {
    return trx
      .updateTable('coms_auth.token_families')
      .set({ revoked_at: sql<Date>`clock_timestamp()` })
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null)
      .execute();
  }

  private async assertAssignableRole(
    trx: Transaction<DB>,
    roleId: string,
  ): Promise<void> {
    const role = await trx
      .selectFrom('coms_auth.roles')
      .select(['id', 'code', 'is_system', 'is_active'])
      .where('id', '=', roleId)
      .forUpdate()
      .executeTakeFirst();
    if (!role) throw new NotFoundException('Role not found');
    if (!role.is_active)
      throw new ConflictException('Cannot assign an inactive role');
    if (role.is_system && role.code === 'SUPER_ADMIN')
      throw new ForbiddenException(
        'Super Admin can only be assigned by the protected bootstrap process',
      );
  }

  private async assertProtectedAdminTarget(
    trx: Transaction<DB>,
    userId: string,
    actorIsSuperAdmin: boolean,
  ): Promise<void> {
    if (actorIsSuperAdmin) return;
    const target = await trx
      .selectFrom('coms_auth.users as u')
      .innerJoin('coms_auth.roles as r', 'r.id', 'u.role_id')
      .select(['r.code', 'r.is_system'])
      .where('u.id', '=', userId)
      .executeTakeFirst();
    if (target?.is_system && target.code === 'SUPER_ADMIN')
      throw new ForbiddenException(
        'Super Admin accounts can only be changed by another Super Admin',
      );
  }

  private async assertActiveBranches(
    trx: Transaction<DB>,
    branchIds: string[],
  ): Promise<void> {
    if (branchIds.length === 0) return;
    const branches = await trx
      .selectFrom('branches')
      .select('id')
      .where('id', 'in', branchIds)
      .where('status', '=', 'active')
      .orderBy('id')
      .forUpdate()
      .execute();
    if (branches.length !== branchIds.length)
      throw new BadRequestException(
        'Every assigned branch must exist and be active',
      );
  }

  private async lockUser(trx: Transaction<DB>, id: string): Promise<void> {
    const user = await trx
      .selectFrom('coms_auth.users')
      .select('id')
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (!user) throw new NotFoundException('Staff account not found');
  }

  private async assertUserInBranch(
    trx: Transaction<DB>,
    userId: string,
    branchId: string,
  ): Promise<void> {
    const branch = await trx
      .selectFrom('coms_auth.branch_users as bu')
      .innerJoin('branches as b', 'b.id', 'bu.branch_id')
      .select('bu.user_id')
      .where('bu.user_id', '=', userId)
      .where('bu.branch_id', '=', branchId)
      .where('b.status', '=', 'active')
      .executeTakeFirst();
    if (!branch) throw new NotFoundException('Staff account not found');
  }

  private async activeBranchesForUsers(
    userIds: string[],
    connection: Connection = this.db,
  ): Promise<Map<string, string[]>> {
    if (userIds.length === 0) return new Map();
    const assignments = await connection
      .selectFrom('coms_auth.branch_users as bu')
      .innerJoin('branches as b', 'b.id', 'bu.branch_id')
      .select(['bu.user_id', 'bu.branch_id'])
      .where('bu.user_id', 'in', userIds)
      .where('b.status', '=', 'active')
      .orderBy('b.branch_name')
      .execute();
    const branches = new Map<string, string[]>();
    for (const assignment of assignments) {
      const current = branches.get(assignment.user_id) ?? [];
      current.push(assignment.branch_id);
      branches.set(assignment.user_id, current);
    }
    return branches;
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
