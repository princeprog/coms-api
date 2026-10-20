import { BadRequestException } from '@nestjs/common';
import { sql } from 'kysely';
import type { DispatchDbExecutor } from './dispatches.types';

export async function lockReceivingBranch(
  db: DispatchDbExecutor,
  branchId: string,
) {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`receiving:${branchId}`}, 0))`.execute(
    db,
  );
}

export function receivingDeadline(value?: string, now = new Date()) {
  const deadline = value
    ? new Date(value)
    : new Date(now.getTime() + 86_400_000);
  if (!Number.isFinite(deadline.getTime()) || deadline <= now)
    throw new BadRequestException('Receive by must be a future date and time');
  return deadline;
}

export function deliveryBusinessDate(
  value: string | undefined,
  sent: Date,
  now: Date,
  lateReason?: string | null,
  deadline?: Date | null,
) {
  const date = (time: Date) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Manila',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(time);
  const today = date(now);
  const actual = value ?? today;
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(actual) ||
    !Number.isFinite(Date.parse(actual)) ||
    new Date(actual).toISOString().slice(0, 10) !== actual ||
    actual < date(sent) ||
    actual > today
  )
    throw new BadRequestException(
      'Delivery date must be between the dispatch date and today',
    );
  if ((actual < today || (deadline && deadline < now)) && !lateReason?.trim())
    throw new BadRequestException(
      'Explain why this count is being submitted late',
    );
  return actual;
}

export const receivingStatus = sql<string>`CASE
  WHEN d.counted_at IS NOT NULL THEN 'COUNTED'
  WHEN EXISTS (SELECT 1 FROM dispatch_late_counts lc WHERE lc.dispatch_id = d.id AND lc.status = 'PENDING') THEN 'REVIEW'
  WHEN d.dispatched_at IS NULL OR d.status NOT IN ('IN_TRANSIT','PARTIALLY_RECEIVED') THEN 'NONE'
  WHEN d.receive_by <= now() THEN 'OVERDUE' ELSE 'AWAITING_COUNT' END`;

export function storedBusinessDate(value: Date | string) {
  return typeof value === 'string'
    ? value.slice(0, 10)
    : new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Manila',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(value);
}
