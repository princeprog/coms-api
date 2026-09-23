import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import { DATABASE } from '../../database/database.module';
import type { DB } from '../../database/db';

@Injectable()
export class BranchesRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DB>) {}

  async list(page: number, pageSize: number, branchIds?: string[]) {
    if (branchIds && branchIds.length === 0)
      return { items: [], total: 0, page, page_size: pageSize };
    let records = this.db
      .selectFrom('branches')
      .selectAll()
      .orderBy('branch_name')
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    let count = this.db
      .selectFrom('branches')
      .select((eb) => eb.fn.countAll<number>().as('total'));
    if (branchIds) {
      records = records.where('id', 'in', branchIds);
      count = count.where('id', 'in', branchIds);
    }
    const [items, result] = await Promise.all([
      records.execute(),
      count.executeTakeFirstOrThrow(),
    ]);
    return { items, total: Number(result.total), page, page_size: pageSize };
  }

  findById(id: string) {
    return this.db
      .selectFrom('branches')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
  }

  async create(input: {
    code: string;
    branch_name: string;
    address?: string | null;
    date_opened?: string | null;
    has_dine_in?: boolean;
  }) {
    try {
      return await this.db
        .insertInto('branches')
        .values({
          code: input.code,
          branch_name: input.branch_name.trim(),
          address: input.address?.trim() || null,
          date_opened: input.date_opened ?? null,
          has_dine_in: input.has_dine_in ?? false,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    } catch (error) {
      if (this.isUniqueViolation(error))
        throw new ConflictException('Branch code already exists');
      throw error;
    }
  }

  async update(
    id: string,
    patch: {
      branch_name?: string;
      address?: string | null;
      date_opened?: string | null;
      has_dine_in?: boolean;
    },
  ) {
    const values = {
      ...patch,
      ...(patch.branch_name !== undefined
        ? { branch_name: patch.branch_name.trim() }
        : {}),
      ...(patch.address !== undefined
        ? { address: patch.address?.trim() || null }
        : {}),
      updated_at: sql<Date>`now()`,
    };
    const branch = await this.db
      .updateTable('branches')
      .set(values)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
    if (!branch) throw new NotFoundException('Branch not found');
    return branch;
  }

  async deactivate(id: string) {
    const branch = await this.db
      .updateTable('branches')
      .set({ status: 'inactive', updated_at: sql<Date>`now()` })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
    if (!branch) throw new NotFoundException('Branch not found');
    return branch;
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
