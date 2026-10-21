import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { DATABASE } from '../../database/database.module';
import type { DB } from '../../database/db';

@Injectable()
export class DailyReportExportRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DB>) {}

  /** One row per stock line, in the order of the given reports. */
  items(reportIds: string[]) {
    if (!reportIds.length) return Promise.resolve([]);
    const quantity = (column: string) =>
      sql<string | null>`${sql.ref(column)}::text`;
    return this.db
      .selectFrom('daily_branch_report_items as item')
      .innerJoin(
        'daily_branch_reports as report',
        'report.id',
        'item.daily_branch_report_id',
      )
      .innerJoin('stock_items as si', 'si.id', 'item.stock_item_id')
      .select([
        sql<string>`report.business_date::text`.as('business_date'),
        'report.status',
        'si.stock_item_name',
        'si.unit',
        quantity('item.opening_quantity').as('opening'),
        quantity('item.receipt_quantity').as('received'),
        quantity('item.sale_consumption_quantity').as('used_by_sales'),
        quantity('item.sale_void_reversal_quantity').as('void_returns'),
        quantity('item.waste_quantity').as('waste'),
        'item.waste_reason',
        quantity('item.adjustment_quantity').as('adjustment'),
        'item.adjustment_reason',
        quantity('item.expected_closing_quantity').as('expected_closing'),
        quantity('item.physical_closing_quantity').as('counted_closing'),
        quantity('item.variance_quantity').as('variance'),
        quantity('item.unit_cost').as('unit_cost'),
        sql<
          string | null
        >`(item.variance_quantity * item.unit_cost)::numeric(14,2)::text`.as(
          'variance_value',
        ),
      ])
      .where(sql<boolean>`report.id = ANY(${reportIds}::uuid[])`)
      .orderBy(sql`array_position(${reportIds}::uuid[], report.id)`)
      .orderBy('si.stock_item_name')
      .execute();
  }
}
