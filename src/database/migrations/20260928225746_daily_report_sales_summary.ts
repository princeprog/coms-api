import { sql, type Kysely } from 'kysely';

// `any` is required here since migrations should be frozen in time. alternatively, keep a "snapshot" db interface.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('daily_branch_reports')
    .addColumn('completed_sales_amount', 'numeric', (column) =>
      column.notNull().defaultTo(0),
    )
    .addColumn('completed_sales_count', 'integer', (column) =>
      column.notNull().defaultTo(0),
    )
    .addColumn('voided_sales_amount', 'numeric', (column) =>
      column.notNull().defaultTo(0),
    )
    .addColumn('voided_sales_count', 'integer', (column) =>
      column.notNull().defaultTo(0),
    )
    .execute();
  await sql`
    ALTER TABLE daily_branch_reports
    ADD CONSTRAINT daily_branch_reports_sales_summary_nonnegative CHECK (
      completed_sales_amount >= 0 AND completed_sales_count >= 0
      AND voided_sales_amount >= 0 AND voided_sales_count >= 0
    )
  `.execute(db);

  await sql`
    WITH report_summaries AS (
      SELECT
        report.id AS report_id,
        coalesce(sum(sale.total_amount)
          FILTER (WHERE event.event_type = 'COMPLETED'), 0) AS completed_amount,
        count(*) FILTER (WHERE event.event_type = 'COMPLETED')::int AS completed_count,
        coalesce(sum(sale.total_amount)
          FILTER (WHERE event.event_type = 'VOIDED'), 0) AS voided_amount,
        count(*) FILTER (WHERE event.event_type = 'VOIDED')::int AS voided_count
      FROM daily_branch_reports AS report
      LEFT JOIN sales AS sale ON sale.branch_id = report.branch_id
      LEFT JOIN sale_events AS event
        ON event.sale_id = sale.id
        AND event.created_at >= (
          report.business_date::timestamp AT TIME ZONE 'Asia/Manila'
        )
        AND event.created_at < (
          (report.business_date + 1)::timestamp AT TIME ZONE 'Asia/Manila'
        )
      GROUP BY report.id
    )
    UPDATE daily_branch_reports AS report
    SET completed_sales_amount = summary.completed_amount,
        completed_sales_count = summary.completed_count,
        voided_sales_amount = summary.voided_amount,
        voided_sales_count = summary.voided_count
    FROM report_summaries AS summary
    WHERE summary.report_id = report.id
  `.execute(db);
}

// `any` is required here since migrations should be frozen in time. alternatively, keep a "snapshot" db interface.
export async function down(db: Kysely<any>): Promise<void> {
  const result = await sql<{ has_saved_values: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM daily_branch_reports
      WHERE completed_sales_amount <> 0 OR completed_sales_count <> 0
        OR voided_sales_amount <> 0 OR voided_sales_count <> 0
    ) AS has_saved_values
  `.execute(db);
  if (result.rows[0]?.has_saved_values)
    throw new Error(
      'Cannot roll back daily report sales snapshots while saved sales totals exist.',
    );

  await sql`
    ALTER TABLE daily_branch_reports
    DROP CONSTRAINT daily_branch_reports_sales_summary_nonnegative
  `.execute(db);
  await db.schema
    .alterTable('daily_branch_reports')
    .dropColumn('completed_sales_amount')
    .dropColumn('completed_sales_count')
    .dropColumn('voided_sales_amount')
    .dropColumn('voided_sales_count')
    .execute();
}
