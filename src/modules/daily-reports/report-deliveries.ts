import { BadRequestException, ConflictException } from '@nestjs/common';
import { sql } from 'kysely';
import type { DispatchDbExecutor } from '../dispatches/dispatches.types';
import { receivingStatus } from '../dispatches/receiving-policy';
import type { DeliveryExceptionDto } from './dto/submit-daily-report.dto';

export function pendingReportDeliveries(
  db: DispatchDbExecutor,
  branchId: string,
  date: string,
) {
  return db
    .selectFrom('dispatches as d')
    .select([
      'd.id',
      'd.dispatched_at',
      'd.receive_by',
      receivingStatus.as('receiving_status'),
    ])
    .where('d.branch_id', '=', branchId)
    .where('d.counted_at', 'is', null)
    .where('d.status', 'in', ['IN_TRANSIT', 'PARTIALLY_RECEIVED'])
    .where(
      'd.dispatched_at',
      '<',
      sql<Date>`coms_business_day_end(${date}::date)`,
    )
    .orderBy('d.dispatched_at')
    .orderBy('d.id')
    .execute();
}

export async function validateReportDeliveries(
  db: DispatchDbExecutor,
  branchId: string,
  date: string,
  exceptions: DeliveryExceptionDto[],
) {
  const pending = await pendingReportDeliveries(db, branchId, date);
  const blocked = await db
    .selectFrom('dispatch_late_counts as lc')
    .innerJoin('dispatches as d', 'd.id', 'lc.dispatch_id')
    .select('lc.id')
    .where('d.branch_id', '=', branchId)
    .where('lc.status', '=', 'PENDING')
    .where('lc.delivery_date', '<=', sql<Date>`${date}::date`)
    .executeTakeFirst();
  if (blocked)
    throw new ConflictException(
      'An arrived delivery has a count awaiting review. Resolve it before submitting this report',
    );
  const ids = new Set(exceptions.map((item) => item.dispatch_id));
  if (
    ids.size !== exceptions.length ||
    exceptions.some((item) => !item.reason.trim())
  )
    throw new BadRequestException(
      'Provide one not-arrived reason per pending delivery',
    );
  if (pending.some((item) => !ids.has(item.id)))
    throw new ConflictException({
      message:
        'Count pending deliveries or explain why each had not arrived by day-end',
      pending_deliveries: pending,
    });
  // A receipt completed while the form was open no longer needs an exception.
  return exceptions.filter((item) =>
    pending.some((delivery) => delivery.id === item.dispatch_id),
  );
}
