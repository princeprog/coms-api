import { storedBusinessDate } from './receiving-policy';
import { ConflictException, Injectable } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import type { DB } from '../../database/db';
import { NotificationWriterRepository } from '../notifications/notification-writer.repository';
import type { ReceiveInput } from './dispatches.types';
import { itemFingerprint } from './dispatches.repository.utils';

@Injectable()
export class DispatchLateCountRepository {
  constructor(private readonly notifications: NotificationWriterRepository) {}

  async prepare(
    tx: Transaction<DB>,
    input: ReceiveInput,
    branchId: string,
    deliveryDate: string,
  ) {
    const existing = await tx
      .selectFrom('dispatch_late_counts')
      .selectAll()
      .where('idempotency_key', '=', input.idempotency_key)
      .executeTakeFirst();
    if (existing) {
      if (
        existing.dispatch_id !== input.id ||
        existing.counted_by_user_id !== input.actor_user_id ||
        storedBusinessDate(existing.delivery_date) !== deliveryDate ||
        existing.late_reason !== (input.late_reason ?? '') ||
        existing.note !== input.note ||
        itemFingerprint(
          existing.items as unknown as ReceiveInput['items'],
          'quantity',
        ) !== itemFingerprint(input.items, 'quantity')
      )
        throw new ConflictException(
          'Idempotency key was already used for another count',
        );
      if (existing.status === 'RETURNED')
        throw new ConflictException(
          'This count was returned. Submit a corrected count with a new retry key',
        );
      if (!input.review_case_id) return existing;
      if (input.review_case_id !== existing.id || existing.status !== 'PENDING')
        throw new ConflictException('This count is no longer awaiting review');
    }
    const pending = await tx
      .selectFrom('dispatch_late_counts')
      .select('id')
      .where('dispatch_id', '=', input.id)
      .where('status', '=', 'PENDING')
      .executeTakeFirst();
    if (pending && pending.id !== input.review_case_id)
      throw new ConflictException(
        'A count for this delivery is already awaiting review',
      );
    const blocker = await tx
      .selectFrom('daily_branch_reports')
      .select(['id', 'status'])
      .where('branch_id', '=', branchId)
      .where('business_date', '>=', sql<Date>`${deliveryDate}::date`)
      .where('status', 'in', ['SUBMITTED', 'APPROVED'])
      .executeTakeFirst();
    if (!blocker) return null;
    if (input.review_case_id)
      throw new ConflictException(
        blocker.status === 'APPROVED'
          ? 'Approved report requires correction; this count must remain on hold'
          : 'Return affected submitted reports before posting this count',
      );
    const saved = await tx
      .insertInto('dispatch_late_counts')
      .values({
        dispatch_id: input.id,
        counted_by_user_id: input.actor_user_id,
        idempotency_key: input.idempotency_key,
        delivery_date: deliveryDate,
        late_reason: input.late_reason ?? '',
        note: input.note,
        items: JSON.stringify(input.items),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const source = await tx
      .insertInto('receiving_notification_sources')
      .values({ branch_id: branchId, late_count_id: saved.id })
      .returning('id')
      .executeTakeFirstOrThrow();
    await this.notifications.publish(tx, {
      kind: 'DISPATCH_LATE_COUNT',
      branch_id: branchId,
      dispatch_id: input.id,
      actor_user_id: input.actor_user_id,
      receiving_source_id: source.id,
    });
    return saved;
  }
}
