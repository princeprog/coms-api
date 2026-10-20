import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import type { DB } from '../../database/db';
import { DATABASE } from '../../database/database.module';
import {
  lockReceivingBranch,
  receivingStatus,
} from '../dispatches/receiving-policy';
import { NotificationWriterRepository } from './notification-writer.repository';

@Injectable()
export class ReceivingRemindersRepository {
  constructor(
    @Inject(DATABASE) private readonly db: Kysely<DB>,
    private readonly notifications: NotificationWriterRepository,
  ) {}

  async sweep() {
    const branches = await sql<{ id: string }>`SELECT b.id FROM branches b
      WHERE b.status = 'active'
      AND EXISTS (SELECT 1 FROM dispatches d WHERE d.branch_id = b.id AND ${receivingStatus} = 'OVERDUE')
      AND NOT EXISTS (SELECT 1 FROM receiving_notification_sources s WHERE s.branch_id = b.id AND s.reminder_date = (now() AT TIME ZONE 'Asia/Manila')::date)
      AND ((now() AT TIME ZONE 'Asia/Manila')::time >= time '09:00'
        OR NOT EXISTS (SELECT 1 FROM receiving_notification_sources s WHERE s.branch_id = b.id AND s.reminder_date IS NOT NULL))
      ORDER BY b.id LIMIT 100`.execute(this.db);
    let sent = 0;
    for (const branch of branches.rows) {
      sent += await this.db.transaction().execute(async (tx) => {
        await lockReceivingBranch(tx, branch.id);
        const active = await tx
          .selectFrom('branches')
          .select('id')
          .where('id', '=', branch.id)
          .where('status', '=', 'active')
          .executeTakeFirst();
        if (!active) return 0;
        const total = await tx
          .selectFrom('dispatches as d')
          .select(sql<number>`count(*)::int`.as('count'))
          .where('d.branch_id', '=', branch.id)
          .where(receivingStatus, '=', 'OVERDUE')
          .executeTakeFirstOrThrow();
        if (!total.count) return 0;
        const source = await tx
          .insertInto('receiving_notification_sources')
          .values({
            branch_id: branch.id,
            reminder_date: sql<Date>`(now() AT TIME ZONE 'Asia/Manila')::date`,
            overdue_count: total.count,
          })
          .onConflict((c) =>
            c.columns(['branch_id', 'reminder_date']).doNothing(),
          )
          .returning('id')
          .executeTakeFirst();
        if (!source) return 0;
        await this.notifications.publish(tx, {
          kind: 'DISPATCH_OVERDUE',
          branch_id: branch.id,
          receiving_source_id: source.id,
          actor_user_id: null,
        });
        return 1;
      });
    }
    return sent;
  }
}
