import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import {
  paginatedResult,
  paginationOffset,
} from '../../common/utils/pagination';
import { DATABASE } from '../../database/database.module';
import type { DB } from '../../database/db';
import type { DailyReportStatus } from './dto/daily-report-query.dto';
import type { DailyReportDirectoryQueryDto } from './dto/daily-report-directory-query.dto';

export const emptyStatusCounts = (): Record<DailyReportStatus, number> => ({
  DRAFT: 0,
  SUBMITTED: 0,
  RETURNED: 0,
  APPROVED: 0,
});

/** Reports across every branch the caller may read, for review queues. */
@Injectable()
export class DailyReportDirectoryRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DB>) {}

  async list(query: DailyReportDirectoryQueryDto, branchIds: string[] | null) {
    const scoped = (withStatus: boolean) => {
      let reports = this.db.selectFrom('daily_branch_reports as report');
      if (branchIds)
        reports = reports.where('report.branch_id', 'in', branchIds);
      if (query.branch_id)
        reports = reports.where('report.branch_id', '=', query.branch_id);
      if (query.date_from)
        reports = reports.where(
          'report.business_date',
          '>=',
          sql<Date>`${query.date_from}::date`,
        );
      if (query.date_to)
        reports = reports.where(
          'report.business_date',
          '<=',
          sql<Date>`${query.date_to}::date`,
        );
      if (withStatus && query.status)
        reports = reports.where('report.status', '=', query.status);
      return reports;
    };
    const direction = query.sort === 'oldest' ? 'asc' : 'desc';
    const [items, total, counts] = await Promise.all([
      scoped(true)
        .innerJoin('branches as branch', 'branch.id', 'report.branch_id')
        .leftJoin(
          'auth.users as submitter',
          'submitter.id',
          'report.submitted_by_user_id',
        )
        .leftJoin(
          'auth.users as reviewer',
          'reviewer.id',
          'report.reviewed_by_user_id',
        )
        .select([
          'report.id',
          'report.branch_id',
          'branch.branch_name',
          'branch.status as branch_status',
          sql<string>`report.business_date::text`.as('business_date'),
          'report.status',
          sql<string>`trim_scale(report.completed_sales_amount)::text`.as(
            'completed_sales_amount',
          ),
          'report.completed_sales_count',
          'report.voided_sales_count',
          'report.submitted_at',
          'submitter.full_name as submitted_by_name',
          'report.reviewed_at',
          'reviewer.full_name as reviewed_by_name',
          'report.updated_at',
          sql<number>`(SELECT count(*)::int FROM daily_branch_report_items AS item
            WHERE item.daily_branch_report_id = report.id)`.as('item_count'),
          sql<number>`(SELECT count(*)::int FROM daily_branch_report_items AS item
            WHERE item.daily_branch_report_id = report.id
              AND item.physical_closing_quantity IS NOT NULL)`.as(
            'counted_count',
          ),
          sql<number>`(SELECT count(*)::int FROM daily_branch_report_items AS item
            WHERE item.daily_branch_report_id = report.id
              AND item.variance_quantity <> 0)`.as('variance_count'),
        ])
        .orderBy('report.business_date', direction)
        .orderBy('branch.branch_name')
        .orderBy('report.id')
        .limit(query.page_size)
        .offset(paginationOffset(query))
        .execute(),
      scoped(true)
        .select(sql<number>`count(*)::int`.as('total'))
        .executeTakeFirstOrThrow(),
      scoped(false)
        .select(['report.status', sql<number>`count(*)::int`.as('count')])
        .groupBy('report.status')
        .execute(),
    ]);
    const status_counts = emptyStatusCounts();
    for (const row of counts)
      status_counts[row.status as DailyReportStatus] = row.count;
    return { ...paginatedResult(items, total.total, query), status_counts };
  }
}
