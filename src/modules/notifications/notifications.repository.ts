import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely, type Transaction } from 'kysely';
import { DATABASE } from '../../database/database.module';
import type { DB } from '../../database/db';
import type { AccessContext } from '../access-control/access-control.types';
import {
  paginatedResult,
  paginationOffset,
} from '../../common/utils/pagination';
import type { NotificationQueryDto } from './dto/notification-query.dto';

@Injectable()
export class NotificationsRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DB>) {}

  private visible(
    executor: Kysely<DB> | Transaction<DB>,
    access: AccessContext,
  ) {
    const superAdmin =
      access.role?.isSystem && access.role.code === 'SUPER_ADMIN';
    let query = executor
      .selectFrom('notification_recipients as nr')
      .innerJoin('notification_events as ne', 'ne.id', 'nr.event_id')
      .innerJoin('branches as b', 'b.id', 'ne.branch_id')
      .leftJoin('daily_branch_reports as report', 'report.id', 'ne.report_id')
      .leftJoin('register_shifts as shift', 'shift.id', 'ne.shift_id')
      .leftJoin(
        'receiving_notification_sources as rs',
        'rs.id',
        'ne.receiving_source_id',
      )
      .where('nr.user_id', '=', access.userId);
    if (!superAdmin) {
      query = query
        .where('b.status', '=', 'active')
        .where(
          'ne.branch_id',
          'in',
          access.branchIds.length ? access.branchIds : [sql<string>`NULL`],
        )
        .where((eb) =>
          eb.or([
            ...(access.permissions.includes('dispatches.read')
              ? [eb('ne.kind', 'like', 'DISPATCH_%')]
              : []),
            ...(access.permissions.includes('daily_reports.read')
              ? [eb('ne.report_id', 'is not', null)]
              : []),
            ...(access.permissions.includes('shifts.read')
              ? [eb('ne.shift_id', 'is not', null)]
              : []),
          ]),
        );
    }
    return query;
  }

  async list(query: NotificationQueryDto, access: AccessContext) {
    return this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .execute(async (transaction) => {
        let records = this.visible(transaction, access);
        if (query.status === 'unread')
          records = records.where('nr.read_at', 'is', null);
        if (query.type === 'dispatches')
          records = records.where('ne.kind', 'like', 'DISPATCH_%');
        if (query.type === 'reports')
          records = records.where('ne.report_id', 'is not', null);
        if (query.type === 'shifts')
          records = records.where('ne.shift_id', 'is not', null);
        const total = await records
          .select(sql<number>`count(*)::int`.as('total'))
          .executeTakeFirstOrThrow();
        const items = await records
          .select([
            'nr.id',
            'ne.kind',
            'ne.branch_id',
            'b.branch_name',
            'ne.dispatch_id',
            'ne.report_id',
            'ne.shift_id',
            'shift.shift_number',
            'rs.overdue_count',
            sql<
              string | null
            >`coalesce(report.business_date, shift.business_date)::text`.as(
              'business_date',
            ),
            'nr.created_at',
            'nr.read_at',
          ])
          .orderBy('nr.created_at', 'desc')
          .orderBy('nr.id', 'desc')
          .offset(paginationOffset(query))
          .limit(query.page_size)
          .execute();
        return paginatedResult(items, total.total, query);
      });
  }

  async unreadCount(access: AccessContext) {
    return this.visible(this.db, access)
      .where('nr.read_at', 'is', null)
      .select([
        sql<number>`count(*)::int`.as('unread_count'),
        sql<Date | null>`max(nr.created_at)`.as('latest_unread_at'),
      ])
      .executeTakeFirstOrThrow();
  }

  async markRead(access: AccessContext, id?: string) {
    let targets = this.visible(this.db, access).select('nr.id');
    if (id) targets = targets.where('nr.id', '=', id);
    else targets = targets.where('nr.read_at', 'is', null);
    // One statement snapshot: later inserts remain unread.
    const update = this.db
      .updateTable('notification_recipients')
      .set({ read_at: sql<Date>`coalesce(read_at, clock_timestamp())` })
      .where('id', 'in', targets);
    if (!id) {
      await update.execute();
      return [];
    }
    return update.returning(['id', 'read_at']).execute();
  }
}
