import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { DATABASE } from '../../database/database.module';
import type { DB } from '../../database/db';
import {
  assertFitsBusinessDay,
  isUniqueViolation,
  lockActiveBranch,
  type Executor,
} from './schedule-support';

/** Enough for round-the-clock branches with overlapping shifts. */
export const MAX_ACTIVE_SHIFTS = 12;

export type ShiftTemplateInput = {
  name: string;
  startTime: string;
  endTime: string;
  weekdays: number[];
};

function duplicateName(error: unknown) {
  if (!isUniqueViolation(error)) return error;
  return new ConflictException({
    code: 'SHIFT_NAME_TAKEN',
    message: 'This branch already has an active shift with this name',
  });
}

@Injectable()
export class ShiftTemplatesRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DB>) {}

  private select(executor: Executor) {
    return executor.selectFrom('branch_shift_templates as t').select([
      't.id',
      't.branch_id',
      't.name',
      sql<string>`to_char(t.start_time, 'HH24:MI')`.as('start_time'),
      sql<string>`to_char(t.end_time, 'HH24:MI')`.as('end_time'),
      't.weekdays',
      't.is_active',
      't.revision',
      sql<number>`(SELECT count(DISTINCT a.user_id)::int
          FROM staff_shift_assignments a WHERE a.template_id = t.id)`.as(
        'staff_count',
      ),
    ]);
  }

  async list(branchId: string, activeOnly = false) {
    const branch = await this.db
      .selectFrom('branches')
      .select('id')
      .where('id', '=', branchId)
      .executeTakeFirst();
    if (!branch) throw new NotFoundException('Branch not found');
    let query = this.select(this.db).where('t.branch_id', '=', branchId);
    if (activeOnly) query = query.where('t.is_active', '=', true);
    return query
      .orderBy('t.is_active', 'desc')
      .orderBy('t.start_time')
      .orderBy('t.name')
      .execute();
  }

  private async find(executor: Executor, branchId: string, id: string) {
    const template = await this.select(executor)
      .where('t.branch_id', '=', branchId)
      .where('t.id', '=', id)
      .executeTakeFirst();
    if (!template) throw new NotFoundException('Shift not found');
    return template;
  }

  private async assertCapacity(executor: Executor, branchId: string) {
    const { count } = await executor
      .selectFrom('branch_shift_templates')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('branch_id', '=', branchId)
      .where('is_active', '=', true)
      .executeTakeFirstOrThrow();
    if (Number(count) >= MAX_ACTIVE_SHIFTS)
      throw new ConflictException({
        code: 'TOO_MANY_SHIFTS',
        message: `A branch can have up to ${MAX_ACTIVE_SHIFTS} active shifts`,
      });
  }

  private async lock(executor: Executor, branchId: string, id: string) {
    const template = await executor
      .selectFrom('branch_shift_templates')
      .select([
        'id',
        'is_active',
        'revision',
        sql<string>`to_char(start_time, 'HH24:MI')`.as('start_time'),
        sql<string>`to_char(end_time, 'HH24:MI')`.as('end_time'),
      ])
      .where('branch_id', '=', branchId)
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (!template) throw new NotFoundException('Shift not found');
    return template;
  }

  async create(
    branchId: string,
    input: ShiftTemplateInput,
    actorUserId: string,
  ) {
    try {
      return await this.db.transaction().execute(async (trx) => {
        await lockActiveBranch(trx, branchId);
        await this.assertCapacity(trx, branchId);
        await assertFitsBusinessDay(trx, input.startTime, input.endTime);
        const created = await trx
          .insertInto('branch_shift_templates')
          .values({
            branch_id: branchId,
            name: input.name,
            start_time: input.startTime,
            end_time: input.endTime,
            weekdays: input.weekdays,
            created_by_user_id: actorUserId,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        return this.find(trx, branchId, created.id);
      });
    } catch (error) {
      throw duplicateName(error);
    }
  }

  async update(
    branchId: string,
    id: string,
    input: ShiftTemplateInput & { revision: number },
  ) {
    try {
      return await this.db.transaction().execute(async (trx) => {
        await lockActiveBranch(trx, branchId);
        const current = await this.lock(trx, branchId, id);
        if (current.revision !== input.revision)
          throw new ConflictException({
            code: 'STALE_SHIFT',
            message:
              'Someone else changed this shift. Reload it and try again.',
          });
        if (current.is_active)
          await assertFitsBusinessDay(trx, input.startTime, input.endTime);
        await trx
          .updateTable('branch_shift_templates')
          .set({
            name: input.name,
            start_time: input.startTime,
            end_time: input.endTime,
            weekdays: input.weekdays,
            revision: sql<number>`revision + 1`,
            updated_at: sql<Date>`now()`,
          })
          .where('id', '=', id)
          .execute();
        // Days the shift no longer runs drop out of everyone's weekly pattern.
        await trx
          .deleteFrom('staff_shift_assignments')
          .where('template_id', '=', id)
          .where('weekday', 'not in', input.weekdays)
          .execute();
        return this.find(trx, branchId, id);
      });
    } catch (error) {
      throw duplicateName(error);
    }
  }

  async setActive(branchId: string, id: string, active: boolean) {
    try {
      return await this.db.transaction().execute(async (trx) => {
        await lockActiveBranch(trx, branchId);
        const current = await this.lock(trx, branchId, id);
        if (current.is_active === active) return this.find(trx, branchId, id);
        if (active) {
          await this.assertCapacity(trx, branchId);
          await assertFitsBusinessDay(
            trx,
            current.start_time,
            current.end_time,
          );
        }
        await trx
          .updateTable('branch_shift_templates')
          .set({
            is_active: active,
            revision: sql<number>`revision + 1`,
            updated_at: sql<Date>`now()`,
          })
          .where('id', '=', id)
          .execute();
        return this.find(trx, branchId, id);
      });
    } catch (error) {
      throw duplicateName(error);
    }
  }
}
