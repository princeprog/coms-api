import {
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import type { DB } from '../../database/db';
import { DATABASE } from '../../database/database.module';
import { NotificationWriterRepository } from '../notifications/notification-writer.repository';
import { DispatchesRepository } from './dispatches.repository';
import { receivingStatus } from './receiving-policy';
import { isUniqueViolation } from './dispatches.repository.utils';
import type { ScopedActionInput } from './dispatches.types';

@Injectable()
export class DispatchCountRemindersRepository {
  constructor(
    @Inject(DATABASE) private readonly db: Kysely<DB>,
    private readonly queries: DispatchesRepository,
    private readonly notifications: NotificationWriterRepository,
  ) {}

  async send(input: ScopedActionInput) {
    try {
      return await this.db.transaction().execute(async (tx) => {
        const dispatch = await this.queries.findDispatchForUpdate(
          tx,
          input.id,
          input.branch_ids,
        );
        if (!dispatch) throw new NotFoundException('Dispatch not found');
        const retry = await this.queries.findEventByIdempotencyKey(
          tx,
          input.idempotency_key,
        );
        if (retry)
          return this.queries.returnForActionRetry(
            tx,
            retry,
            input,
            'COUNT_REMINDER_SENT',
          );
        await this.queries.requireActiveBranch(tx, dispatch.branch_id);
        const state = await tx
          .selectFrom('dispatches as d')
          .select(receivingStatus.as('status'))
          .where('d.id', '=', input.id)
          .executeTakeFirstOrThrow();
        if (!['AWAITING_COUNT', 'OVERDUE'].includes(state.status))
          throw new ConflictException(
            'This delivery no longer needs a count reminder. Refresh to see its current status.',
          );
        // clock_timestamp reflects time after acquiring the receiving lock.
        const cooldown = await sql<{
          next_allowed_at: Date;
          retry_after_seconds: number;
        }>`SELECT created_at + interval '30 minutes' AS next_allowed_at,
          greatest(1, ceil(extract(epoch FROM created_at + interval '30 minutes' - clock_timestamp())))::int AS retry_after_seconds
          FROM dispatch_events WHERE dispatch_id = ${input.id}::uuid AND event_type = 'COUNT_REMINDER_SENT'
          AND created_at + interval '30 minutes' > clock_timestamp() ORDER BY created_at DESC LIMIT 1`.execute(
          tx,
        );
        if (cooldown.rows[0])
          throw new HttpException(
            {
              message:
                'A reminder was already sent. Please wait before sending another.',
              next_allowed_at: cooldown.rows[0].next_allowed_at.toISOString(),
              retry_after_seconds: cooldown.rows[0].retry_after_seconds,
            },
            429,
          );
        const event = await tx
          .insertInto('dispatch_events')
          .values({
            dispatch_id: input.id,
            event_type: 'COUNT_REMINDER_SENT',
            actor_user_id: input.actor_user_id,
            idempotency_key: input.idempotency_key,
            created_at: sql<Date>`clock_timestamp()`,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        const recipients = await this.notifications.publish(
          tx,
          {
            kind: 'DISPATCH_COUNT_REMINDER',
            dispatch_event_id: event.id,
            dispatch_id: input.id,
            branch_id: dispatch.branch_id,
            actor_user_id: input.actor_user_id,
          },
          {
            excludeUserIds: dispatch.dispatched_by_user_id
              ? [dispatch.dispatched_by_user_id]
              : [],
          },
        );
        if (!recipients)
          throw new ConflictException(
            'No eligible receiving staff are assigned to this branch. Ask an administrator to check branch assignments and receiving permissions.',
          );
        return this.queries.findDetails(tx, input.id);
      });
    } catch (error) {
      if (isUniqueViolation(error))
        throw new ConflictException(
          'Idempotency key was already used for another action',
        );
      throw error;
    }
  }
}
