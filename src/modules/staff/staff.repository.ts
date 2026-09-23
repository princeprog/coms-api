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
  ) {
    const pattern = search?.trim() ? `%${search.trim()}%` : undefined;
    let records = this.db
      .selectFrom('auth.users as u')
      .innerJoin('auth.roles as r', 'r.id', 'u.role_id')
      .select([
        'u.id',
        'u.email',
        'u.full_name',
        'u.contact_number',
        'u.is_active',
        'r.id as role_id',
        'r.code as role_code',
        'r.role_name as role_name',
      ])
      .orderBy('u.full_name')
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    let count = this.db
      .selectFrom('auth.users as u')
      .select((eb) => eb.fn.countAll<number>().as('total'));
    if (branchId) {
      const branchUserIds = this.db
        .selectFrom('auth.branch_users as bu')
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
    const [staff, total] = await Promise.all([
      records.execute(),
      count.executeTakeFirstOrThrow(),
    ]);
    const branchesByUser = await this.activeBranchesForUsers(
      staff.map(({ id }) => id),
    );
    return {
      items: staff.map((member) => ({
        ...member,
        branch_ids: (branchesByUser.get(member.id) ?? []).filter(
          (id) => !visibleBranchIds || visibleBranchIds.includes(id),
        ),
      })),
      total: Number(total.total),
      page,
      page_size: pageSize,
    };
  }

  async findById(
    id: string,
    connection: Connection = this.db,
    requiredBranchId?: string,
  ) {
    let memberQuery = connection
      .selectFrom('auth.users as u')
      .innerJoin('auth.roles as r', 'r.id', 'u.role_id')
      .select([
        'u.id',
        'u.email',
        'u.full_name',
        'u.contact_number',
        'u.is_active',
        'r.id as role_id',
        'r.code as role_code',
        'r.role_name as role_name',
      ])
      .where('u.id', '=', id);
    if (requiredBranchId) {
      const usersInBranch = connection
        .selectFrom('auth.branch_users as bu')
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
    role_id: string;
    branch_ids: string[];
  }) {
    try {
      return await this.db.transaction().execute(async (trx) => {
        await this.assertAssignableRole(trx, input.role_id);
        await this.assertActiveBranches(trx, input.branch_ids);
        const user = await trx
          .insertInto('auth.users')
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
            .insertInto('auth.branch_users')
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
          .updateTable('auth.users')
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
    roleId: string,
    actorIsSuperAdmin: boolean,
    branchId?: string,
  ) {
    return this.db.transaction().execute(async (trx) => {
      await this.lockUser(trx, id);
      if (branchId) await this.assertUserInBranch(trx, id, branchId);
      await this.assertProtectedAdminTarget(trx, id, actorIsSuperAdmin);
      await this.assertAssignableRole(trx, roleId);
      const changed = await trx
        .updateTable('auth.users')
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
      await trx
        .deleteFrom('auth.branch_users')
        .where('user_id', '=', id)
        .execute();
      if (assignedBranchIds.length)
        await trx
          .insertInto('auth.branch_users')
          .values(
            assignedBranchIds.map((branch_id) => ({
              user_id: id,
              branch_id,
            })),
          )
          .execute();
      return this.findById(id, trx);
    });
  }

  async deactivate(id: string, actorIsSuperAdmin: boolean, branchId?: string) {
    return this.db.transaction().execute(async (trx) => {
      await this.lockUser(trx, id);
      if (branchId) await this.assertUserInBranch(trx, id, branchId);
      await this.assertProtectedAdminTarget(trx, id, actorIsSuperAdmin);
      const member = await trx
        .updateTable('auth.users')
        .set({ is_active: false, updated_at: sql<Date>`now()` })
        .where('id', '=', id)
        .returning(['id'])
        .executeTakeFirst();
      if (!member) throw new NotFoundException('Staff account not found');
      await trx
        .updateTable('auth.token_families')
        .set({ revoked_at: sql<Date>`clock_timestamp()` })
        .where('user_id', '=', id)
        .where('revoked_at', 'is', null)
        .execute();
      return this.findById(id, trx);
    });
  }

  private async assertAssignableRole(
    trx: Transaction<DB>,
    roleId: string,
  ): Promise<void> {
    const role = await trx
      .selectFrom('auth.roles')
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
      .selectFrom('auth.users as u')
      .innerJoin('auth.roles as r', 'r.id', 'u.role_id')
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
      .selectFrom('auth.users')
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
      .selectFrom('auth.branch_users as bu')
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
      .selectFrom('auth.branch_users as bu')
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
