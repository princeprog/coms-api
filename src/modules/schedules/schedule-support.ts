import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../database/db';
import { crossesDayStart } from './schedule-policy';
import { scheduledShiftsSql } from './schedule-occurrences';

export type Executor = Kysely<DB> | Transaction<DB>;

/** Opening a register this early still counts as working the shift. */
export const EARLY_OPEN_MINUTES = 30;

export async function businessToday(executor: Executor) {
  const { rows } = await sql<{
    today: string;
  }>`SELECT coms_business_date(now())::text AS today`.execute(executor);
  return rows[0]!.today;
}

/** The current business-day start time and any scheduled future one ("HH:MM"). */
export async function dayStartTimes(executor: Executor) {
  const { rows } = await sql<{ start_time: string }>`
    SELECT to_char(start_time, 'HH24:MI') AS start_time
    FROM business_day_rules
    WHERE effective_from >= coalesce((
      SELECT max(effective_from) FROM business_day_rules
      WHERE effective_from <= coms_business_date(now())), '-infinity')
    ORDER BY effective_from
  `.execute(executor);
  return rows.map((row) => row.start_time);
}

/** Rejects a shift that would run past a current or scheduled business-day start. */
export async function assertFitsBusinessDay(
  executor: Executor,
  startTime: string,
  endTime: string,
) {
  const crossed = (await dayStartTimes(executor)).find((dayStart) =>
    crossesDayStart(startTime, endTime, dayStart),
  );
  if (crossed)
    throw new BadRequestException({
      code: 'SHIFT_CROSSES_DAY_START',
      message: `Shifts can't run past the business day start (${crossed}). End this shift at ${crossed} and start another, or change the business day start.`,
    });
}

/** Locks an active branch so concurrent schedule edits serialize. */
export async function lockActiveBranch(executor: Executor, branchId: string) {
  const branch = await executor
    .selectFrom('branches')
    .select(['id', 'branch_name', 'status'])
    .where('id', '=', branchId)
    .forUpdate()
    .executeTakeFirst();
  if (!branch || branch.status !== 'active')
    throw new NotFoundException('Active branch not found');
  return branch;
}

/** An active staff member assigned to the branch, locked for the edit. */
export async function lockBranchMember(
  executor: Executor,
  branchId: string,
  userId: string,
) {
  const member = await executor
    .selectFrom('coms_auth.users as u')
    .innerJoin('coms_auth.branch_users as bu', 'bu.user_id', 'u.id')
    .select(['u.id', 'u.full_name'])
    .where('u.id', '=', userId)
    .where('u.is_active', '=', true)
    .where('bu.branch_id', '=', branchId)
    .forUpdate()
    .executeTakeFirst();
  if (!member)
    throw new NotFoundException(
      'This staff member is not active at this branch',
    );
  return member;
}

/**
 * Whether the person opening a register is on the schedule now. Shifts of the
 * current and next business date are checked so an early opening counts.
 */
export async function scheduleStatusForOpen(
  executor: Executor,
  branchId: string,
  userId: string,
) {
  const shifts = scheduledShiftsSql({
    from: sql`coms_business_date(now())`,
    to: sql`coms_business_date(now()) + 1`,
    branchIds: [branchId],
    userIds: [userId],
  });
  const { rows } = await sql<{
    has_templates: boolean;
    template_name: string | null;
  }>`
    SELECT
      EXISTS (SELECT 1 FROM branch_shift_templates
        WHERE branch_id = ${branchId} AND is_active) AS has_templates,
      (SELECT o.template_name FROM (${shifts}) AS o
        WHERE o.starts_at - make_interval(mins => ${EARLY_OPEN_MINUTES}) <= now()
          AND now() < o.ends_at
        ORDER BY o.starts_at LIMIT 1) AS template_name
  `.execute(executor);
  const { has_templates, template_name } = rows[0]!;
  if (template_name)
    return { status: 'SCHEDULED' as const, shiftName: template_name };
  return {
    status: has_templates ? ('UNSCHEDULED' as const) : ('NO_SCHEDULE' as const),
    shiftName: null,
  };
}

/**
 * Removes a person's weekly pattern and upcoming exceptions, at the given
 * branches or everywhere. Call it in the transaction that removes branch
 * access or deactivates the account.
 */
export async function clearStaffSchedules(
  executor: Executor,
  userId: string,
  branchIds?: string[],
) {
  if (branchIds && !branchIds.length) return;
  let assignments = executor
    .deleteFrom('staff_shift_assignments')
    .where('user_id', '=', userId);
  let exceptions = executor
    .deleteFrom('staff_shift_exceptions')
    .where('user_id', '=', userId)
    .where(sql<boolean>`work_date >= coms_business_date(now())`);
  if (branchIds) {
    assignments = assignments.where('branch_id', 'in', branchIds);
    exceptions = exceptions.where('branch_id', 'in', branchIds);
  }
  await assignments.execute();
  await exceptions.execute();
}

export function isUniqueViolation(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505'
  );
}

export function scheduleOverlap(message: string) {
  return new ConflictException({ code: 'SCHEDULE_OVERLAP', message });
}
