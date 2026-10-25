import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { DATABASE } from '../../database/database.module';
import type { DB } from '../../database/db';
import { listDiff, recordAudit } from '../audit/audit-recorder';
import {
  addDays,
  dayWindow,
  isoWeekday,
  timeRange,
  weekStart as mondayOf,
  weekdayName,
  windowsOverlap,
} from './schedule-policy';
import { scheduledShiftsSql } from './schedule-occurrences';
import {
  businessToday,
  dayStartTimes,
  isUniqueViolation,
  lockActiveBranch,
  lockBranchMember,
  scheduleOverlap,
  type Executor,
} from './schedule-support';

/** How far ahead dated changes may be planned. */
const PLANNING_DAYS = 366;
const MY_SCHEDULE_DAYS = 14;

type PatternTemplate = {
  id: string;
  name: string;
  start_time: string;
  end_time: string;
  weekdays: number[];
  branch_name: string;
};

@Injectable()
export class SchedulesRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DB>) {}

  private templates(executor: Executor) {
    return executor
      .selectFrom('branch_shift_templates as t')
      .innerJoin('branches as b', 'b.id', 't.branch_id')
      .select([
        't.id',
        't.branch_id',
        't.name',
        sql<string>`to_char(t.start_time, 'HH24:MI')`.as('start_time'),
        sql<string>`to_char(t.end_time, 'HH24:MI')`.as('end_time'),
        't.weekdays',
        'b.branch_name',
      ])
      .where('t.is_active', '=', true);
  }

  async week(branchId: string, requestedWeek: string | null) {
    const branch = await this.db
      .selectFrom('branches')
      .select(['id', 'branch_name', 'status'])
      .where('id', '=', branchId)
      .executeTakeFirst();
    if (!branch) throw new NotFoundException('Branch not found');
    const weekStart = requestedWeek ?? mondayOf(await businessToday(this.db));
    const weekEnd = addDays(weekStart, 6);
    const [today, dayStarts, templates, staff, pattern, shifts, off] =
      await Promise.all([
        businessToday(this.db),
        dayStartTimes(this.db),
        this.templates(this.db)
          .where('t.branch_id', '=', branchId)
          .orderBy('t.start_time')
          .orderBy('t.name')
          .execute(),
        this.db
          .selectFrom('coms_auth.branch_users as bu')
          .innerJoin('coms_auth.users as u', 'u.id', 'bu.user_id')
          .leftJoin('coms_auth.roles as r', 'r.id', 'u.role_id')
          .select(['u.id as user_id', 'u.full_name', 'r.role_name'])
          .where('bu.branch_id', '=', branchId)
          .where('u.is_active', '=', true)
          .orderBy('u.full_name')
          .execute(),
        this.db
          .selectFrom('staff_shift_assignments as a')
          .innerJoin('branch_shift_templates as t', 't.id', 'a.template_id')
          .select(['a.user_id', 'a.template_id', 'a.weekday'])
          .where('a.branch_id', '=', branchId)
          .where('t.is_active', '=', true)
          .orderBy('a.weekday')
          .execute(),
        sql<{
          work_date: string;
          user_id: string;
          full_name: string;
          template_id: string;
          source: 'PATTERN' | 'EXTRA';
          exception_id: string | null;
          starts_at: Date;
          ends_at: Date;
        }>`
          SELECT work_date, user_id, full_name, template_id, source,
            exception_id, starts_at, ends_at
          FROM (${scheduledShiftsSql({ from: weekStart, to: weekEnd, branchIds: [branchId] })}) AS o
          ORDER BY starts_at, full_name
        `.execute(this.db),
        this.db
          .selectFrom('staff_shift_exceptions as x')
          .innerJoin('coms_auth.users as u', 'u.id', 'x.user_id')
          .innerJoin('branch_shift_templates as t', 't.id', 'x.template_id')
          .select([
            'x.id as exception_id',
            sql<string>`x.work_date::text`.as('work_date'),
            'x.user_id',
            'u.full_name',
            'x.template_id',
            'x.reason',
          ])
          .where('x.branch_id', '=', branchId)
          .where('x.kind', '=', 'OFF')
          .where('t.is_active', '=', true)
          .where(
            sql<boolean>`x.work_date BETWEEN ${weekStart}::date AND ${weekEnd}::date`,
          )
          .orderBy('u.full_name')
          .execute(),
      ]);
    return {
      branch: {
        id: branch.id,
        name: branch.branch_name,
        is_active: branch.status === 'active',
      },
      week_start: weekStart,
      days: Array.from({ length: 7 }, (_, index) => {
        const date = addDays(weekStart, index);
        return { date, weekday: index + 1, is_past: date < today };
      }),
      business_today: today,
      day_start_time: dayStarts[0] ?? '00:00',
      templates: templates.map((template) => ({
        id: template.id,
        name: template.name,
        start_time: template.start_time,
        end_time: template.end_time,
        weekdays: template.weekdays,
      })),
      staff,
      pattern,
      shifts: shifts.rows,
      off,
    };
  }

  async replacePattern(
    branchId: string,
    userId: string,
    assignments: { template_id: string; weekday: number }[],
  ) {
    return this.db.transaction().execute(async (trx) => {
      await lockActiveBranch(trx, branchId);
      const member = await lockBranchMember(trx, branchId, userId);
      const templateIds = [...new Set(assignments.map((a) => a.template_id))];
      const templates = templateIds.length
        ? await this.templates(trx)
            .where('t.branch_id', '=', branchId)
            .where('t.id', 'in', templateIds)
            .execute()
        : [];
      const byId = new Map(templates.map((t) => [t.id, t]));
      const chosen = assignments.map((assignment) => {
        const template = byId.get(assignment.template_id);
        if (!template)
          throw new BadRequestException('Choose active shifts of this branch');
        if (!template.weekdays.includes(assignment.weekday))
          throw new BadRequestException(
            `${template.name} doesn't run on ${weekdayName(assignment.weekday)}`,
          );
        return { ...assignment, template };
      });
      const elsewhere = await trx
        .selectFrom('staff_shift_assignments as a')
        .innerJoin('branch_shift_templates as t', 't.id', 'a.template_id')
        .innerJoin('branches as b', 'b.id', 'a.branch_id')
        .select([
          'a.weekday',
          't.id',
          't.name',
          sql<string>`to_char(t.start_time, 'HH24:MI')`.as('start_time'),
          sql<string>`to_char(t.end_time, 'HH24:MI')`.as('end_time'),
          't.weekdays',
          'b.branch_name',
        ])
        .where('a.user_id', '=', userId)
        .where('a.branch_id', '<>', branchId)
        .where('t.is_active', '=', true)
        .where('b.status', '=', 'active')
        .execute();
      this.assertPatternFits(
        member.full_name,
        [
          ...chosen,
          ...elsewhere
            .filter((row) => row.weekdays.includes(row.weekday))
            .map((row) => ({ weekday: row.weekday, template: row })),
        ],
        (await dayStartTimes(trx))[0] ?? '00:00',
      );
      const label = (row: { weekday: number; name: string }) =>
        `${weekdayName(row.weekday)} · ${row.name}`;
      const previous = await trx
        .selectFrom('staff_shift_assignments as a')
        .innerJoin('branch_shift_templates as t', 't.id', 'a.template_id')
        .select(['a.weekday', 't.name'])
        .where('a.branch_id', '=', branchId)
        .where('a.user_id', '=', userId)
        .execute();
      await trx
        .deleteFrom('staff_shift_assignments')
        .where('branch_id', '=', branchId)
        .where('user_id', '=', userId)
        .execute();
      if (chosen.length)
        await trx
          .insertInto('staff_shift_assignments')
          .values(
            chosen.map((assignment) => ({
              branch_id: branchId,
              user_id: userId,
              template_id: assignment.template_id,
              weekday: assignment.weekday,
            })),
          )
          .onConflict((conflict) => conflict.doNothing())
          .execute();
      const { added, removed } = listDiff(
        previous.map(label),
        chosen.map((row) =>
          label({ weekday: row.weekday, name: row.template.name }),
        ),
      );
      if (added.length || removed.length)
        await recordAudit(trx, {
          action: 'staff.schedule_updated',
          entityType: 'staff',
          entityId: userId,
          entityLabel: member.full_name,
          branchId,
          metadata: { added, removed },
        });
      return {
        user_id: userId,
        assignments: chosen.map(({ template_id, weekday }) => ({
          template_id,
          weekday,
        })),
      };
    });
  }

  /** No one can hold two overlapping shifts on the same weekday, at any branch. */
  private assertPatternFits(
    name: string,
    rows: { weekday: number; template: PatternTemplate }[],
    dayStart: string,
  ) {
    for (let i = 0; i < rows.length; i++)
      for (let j = i + 1; j < rows.length; j++) {
        const a = rows[i]!;
        const b = rows[j]!;
        if (a.weekday !== b.weekday || a.template.id === b.template.id)
          continue;
        const first = dayWindow(
          a.template.start_time,
          a.template.end_time,
          dayStart,
        );
        const second = dayWindow(
          b.template.start_time,
          b.template.end_time,
          dayStart,
        );
        if (windowsOverlap(first, second))
          throw scheduleOverlap(
            `${name} would work ${a.template.name} (${timeRange(a.template.start_time, a.template.end_time)}) and ${b.template.name} (${timeRange(b.template.start_time, b.template.end_time)}) at ${b.template.branch_name} on ${weekdayName(a.weekday)}. Shifts can't overlap.`,
          );
      }
  }

  async addException(
    branchId: string,
    input: {
      userId: string;
      templateId: string;
      workDate: string;
      kind: 'OFF' | 'EXTRA';
      reason: string | null;
    },
    actorUserId: string,
  ) {
    try {
      return await this.db.transaction().execute(async (trx) => {
        const today = await businessToday(trx);
        if (input.workDate < today)
          throw new BadRequestException('Choose today or a later date');
        if (input.workDate > addDays(today, PLANNING_DAYS))
          throw new BadRequestException('Choose a date within the next year');
        await lockActiveBranch(trx, branchId);
        const member = await lockBranchMember(trx, branchId, input.userId);
        const template = await this.templates(trx)
          .where('t.branch_id', '=', branchId)
          .where('t.id', '=', input.templateId)
          .executeTakeFirst();
        if (!template)
          throw new BadRequestException(
            'Choose an active shift of this branch',
          );
        const weekday = isoWeekday(input.workDate);
        const inPattern =
          template.weekdays.includes(weekday) &&
          !!(await trx
            .selectFrom('staff_shift_assignments')
            .select('id')
            .where('user_id', '=', input.userId)
            .where('template_id', '=', input.templateId)
            .where('weekday', '=', weekday)
            .executeTakeFirst());
        const off = await trx
          .selectFrom('staff_shift_exceptions')
          .select('id')
          .where('user_id', '=', input.userId)
          .where('template_id', '=', input.templateId)
          .where(sql<boolean>`work_date = ${input.workDate}::date`)
          .where('kind', '=', 'OFF')
          .executeTakeFirst();
        const shift = `${template.name} on ${weekdayName(weekday)}, ${input.workDate}`;
        if (input.kind === 'OFF' && !inPattern)
          throw new ConflictException({
            code: 'NOT_SCHEDULED',
            message: `${member.full_name} isn't scheduled for ${shift}`,
          });
        if (input.kind === 'EXTRA' && inPattern && !off)
          throw new ConflictException({
            code: 'ALREADY_SCHEDULED',
            message: `${member.full_name} is already scheduled for ${shift}`,
          });
        let exceptionId: string | null = null;
        if (input.kind === 'EXTRA' && off) {
          // Adding someone back on their day off simply cancels the day off.
          await trx
            .deleteFrom('staff_shift_exceptions')
            .where('id', '=', off.id)
            .execute();
        } else {
          exceptionId = (
            await trx
              .insertInto('staff_shift_exceptions')
              .values({
                branch_id: branchId,
                user_id: input.userId,
                template_id: input.templateId,
                work_date: input.workDate,
                kind: input.kind,
                reason: input.reason,
                created_by_user_id: actorUserId,
              })
              .returning('id')
              .executeTakeFirstOrThrow()
          ).id;
        }
        if (input.kind === 'EXTRA')
          await this.assertDateFits(
            trx,
            member.full_name,
            input.userId,
            input.workDate,
          );
        await recordAudit(trx, {
          action:
            input.kind === 'OFF'
              ? 'staff.schedule_day_off'
              : 'staff.schedule_extra_shift',
          entityType: 'staff',
          entityId: input.userId,
          entityLabel: member.full_name,
          branchId,
          metadata: {
            date: input.workDate,
            shift: template.name,
            reason: input.reason,
          },
        });
        return { id: exceptionId, kind: input.kind, work_date: input.workDate };
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      throw new ConflictException('This change is already on the schedule');
    }
  }

  private async assertDateFits(
    executor: Executor,
    name: string,
    userId: string,
    workDate: string,
  ) {
    const { rows } = await sql<{
      template_name: string;
      branch_name: string;
      starts_at: Date;
      ends_at: Date;
    }>`
      SELECT template_name, branch_name, starts_at, ends_at
      FROM (${scheduledShiftsSql({ from: workDate, to: workDate, userIds: [userId] })}) AS o
      ORDER BY starts_at
    `.execute(executor);
    for (let i = 1; i < rows.length; i++) {
      const previous = rows[i - 1]!;
      const current = rows[i]!;
      if (current.starts_at < previous.ends_at)
        throw scheduleOverlap(
          `${name} would work ${previous.template_name} at ${previous.branch_name} and ${current.template_name} at ${current.branch_name} at the same time on ${workDate}. Shifts can't overlap.`,
        );
    }
  }

  async removeException(branchId: string, exceptionId: string) {
    return this.db.transaction().execute(async (trx) => {
      const removed = await trx
        .deleteFrom('staff_shift_exceptions as x')
        .using(['coms_auth.users as u', 'branch_shift_templates as t'])
        .whereRef('u.id', '=', 'x.user_id')
        .whereRef('t.id', '=', 'x.template_id')
        .where('x.id', '=', exceptionId)
        .where('x.branch_id', '=', branchId)
        .returning([
          'x.user_id',
          'x.kind',
          sql<string>`x.work_date::text`.as('work_date'),
          'u.full_name',
          't.name',
        ])
        .executeTakeFirst();
      if (!removed) throw new NotFoundException('Schedule change not found');
      await recordAudit(trx, {
        action: 'staff.schedule_change_removed',
        entityType: 'staff',
        entityId: removed.user_id,
        entityLabel: removed.full_name,
        branchId,
        metadata: {
          date: removed.work_date,
          shift: removed.name,
          kind: removed.kind,
        },
      });
      return { removed: true };
    });
  }

  async mine(userId: string) {
    const today = await businessToday(this.db);
    const { rows } = await sql<{
      work_date: string;
      branch_id: string;
      branch_name: string;
      template_id: string;
      template_name: string;
      start_time: string;
      end_time: string;
      starts_at: Date;
      ends_at: Date;
      source: 'PATTERN' | 'EXTRA';
    }>`
      SELECT work_date, branch_id, branch_name, template_id, template_name,
        start_time, end_time, starts_at, ends_at, source
      FROM (${scheduledShiftsSql({ from: today, to: addDays(today, MY_SCHEDULE_DAYS - 1), userIds: [userId] })}) AS o
      ORDER BY starts_at
    `.execute(this.db);
    return { business_today: today, days: MY_SCHEDULE_DAYS, shifts: rows };
  }
}
