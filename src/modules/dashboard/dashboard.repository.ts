import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { DATABASE } from '../../database/database.module';
import type { DB } from '../../database/db';
import type { DashboardDateRange } from './dashboard-date-range';

type BranchSummaryRow = {
  branch_id: string;
  branch_name: string;
  branch_status: string;
  completed_sales_amount: string;
  completed_sales_count: number;
  voided_sales_amount: string;
  voided_sales_count: number;
  units_sold: string;
  submitted_reports_count: number;
  approved_reports_count: number;
  open_discrepancies_count: number;
  in_transit_dispatches_count: number;
};

type SalesTrendRow = {
  date: string;
  completed_sales_amount: string;
  completed_sales_count: number;
  voided_sales_amount: string;
  voided_sales_count: number;
  units_sold: string;
};

const ZERO_SUMMARY = {
  completed_sales_amount: '0',
  completed_sales_count: 0,
  voided_sales_amount: '0',
  voided_sales_count: 0,
  units_sold: '0',
  submitted_reports_count: 0,
  approved_reports_count: 0,
  open_discrepancies_count: 0,
  in_transit_dispatches_count: 0,
};

@Injectable()
export class DashboardRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DB>) {}

  async overview(range: DashboardDateRange, branchId?: string) {
    const branches = await sql<BranchSummaryRow>`
      WITH selected_branches AS (
        SELECT id, branch_name, status
        FROM branches
        WHERE ${branchId ?? null}::uuid IS NULL OR id = ${branchId ?? null}::uuid
      ),
      sales_events AS (
        SELECT s.branch_id, se.sale_id, se.event_type, s.total_amount,
               (SELECT coalesce(sum(si.quantity), 0)
                FROM sale_items AS si WHERE si.sale_id = s.id) AS units
        FROM sale_events AS se
        JOIN sales AS s ON s.id = se.sale_id
        JOIN selected_branches AS branch ON branch.id = s.branch_id
        WHERE se.created_at >= ${range.startAt}
          AND se.created_at < ${range.endExclusiveAt}
          AND se.event_type IN ('COMPLETED', 'VOIDED')
      ),
      sales_totals AS (
        SELECT branch_id,
          coalesce(sum(total_amount) FILTER (WHERE event_type = 'COMPLETED'), 0)::text AS completed_sales_amount,
          count(*) FILTER (WHERE event_type = 'COMPLETED')::int AS completed_sales_count,
          coalesce(sum(total_amount) FILTER (WHERE event_type = 'VOIDED'), 0)::text AS voided_sales_amount,
          count(*) FILTER (WHERE event_type = 'VOIDED')::int AS voided_sales_count,
          coalesce(sum(units) FILTER (WHERE event_type = 'COMPLETED'), 0)::text AS units_sold
        FROM sales_events
        GROUP BY branch_id
      ),
      report_totals AS (
        SELECT branch_id,
          count(*) FILTER (WHERE status = 'SUBMITTED')::int AS submitted_reports_count,
          count(*) FILTER (WHERE status = 'APPROVED')::int AS approved_reports_count
        FROM daily_branch_reports
        WHERE business_date BETWEEN ${range.from}::date AND ${range.to}::date
        GROUP BY branch_id
      ),
      discrepancy_totals AS (
        SELECT d.branch_id, count(*)::int AS open_discrepancies_count
        FROM dispatch_discrepancies AS discrepancy
        JOIN dispatches AS d ON d.id = discrepancy.dispatch_id
        JOIN selected_branches AS branch ON branch.id = d.branch_id
        WHERE discrepancy.status IN ('OPEN', 'RECOUNT_REQUESTED')
        GROUP BY d.branch_id
      ),
      transit_totals AS (
        SELECT d.branch_id, count(*)::int AS in_transit_dispatches_count
        FROM dispatches AS d
        JOIN selected_branches AS branch ON branch.id = d.branch_id
        WHERE d.status IN ('IN_TRANSIT', 'PARTIALLY_RECEIVED')
        GROUP BY d.branch_id
      )
      SELECT branch.id AS branch_id, branch.branch_name,
        branch.status AS branch_status,
        coalesce(sales.completed_sales_amount, '0') AS completed_sales_amount,
        coalesce(sales.completed_sales_count, 0)::int AS completed_sales_count,
        coalesce(sales.voided_sales_amount, '0') AS voided_sales_amount,
        coalesce(sales.voided_sales_count, 0)::int AS voided_sales_count,
        coalesce(sales.units_sold, '0') AS units_sold,
        coalesce(reports.submitted_reports_count, 0)::int AS submitted_reports_count,
        coalesce(reports.approved_reports_count, 0)::int AS approved_reports_count,
        coalesce(discrepancies.open_discrepancies_count, 0)::int AS open_discrepancies_count,
        coalesce(transit.in_transit_dispatches_count, 0)::int AS in_transit_dispatches_count
      FROM selected_branches AS branch
      LEFT JOIN sales_totals AS sales ON sales.branch_id = branch.id
      LEFT JOIN report_totals AS reports ON reports.branch_id = branch.id
      LEFT JOIN discrepancy_totals AS discrepancies ON discrepancies.branch_id = branch.id
      LEFT JOIN transit_totals AS transit ON transit.branch_id = branch.id
      ORDER BY branch.branch_name, branch.id
    `.execute(this.db);

    if (branchId && branches.rows.length === 0)
      throw new NotFoundException('Branch not found');

    const branchRows = branches.rows;
    const summary = branchRows.reduce(
      (totals, branch) => ({
        completed_sales_amount: addDecimal(
          totals.completed_sales_amount,
          branch.completed_sales_amount,
        ),
        completed_sales_count:
          totals.completed_sales_count + branch.completed_sales_count,
        voided_sales_amount: addDecimal(
          totals.voided_sales_amount,
          branch.voided_sales_amount,
        ),
        voided_sales_count:
          totals.voided_sales_count + branch.voided_sales_count,
        units_sold: addDecimal(totals.units_sold, branch.units_sold),
        submitted_reports_count:
          totals.submitted_reports_count + branch.submitted_reports_count,
        approved_reports_count:
          totals.approved_reports_count + branch.approved_reports_count,
        open_discrepancies_count:
          totals.open_discrepancies_count + branch.open_discrepancies_count,
        in_transit_dispatches_count:
          totals.in_transit_dispatches_count +
          branch.in_transit_dispatches_count,
      }),
      { ...ZERO_SUMMARY },
    );

    const trend = await sql<SalesTrendRow>`
      WITH calendar AS (
        SELECT generate_series(
          ${range.from}::date,
          ${range.to}::date,
          interval '1 day'
        )::date AS business_date
      ),
      sales_events AS (
        SELECT se.event_type, se.created_at, s.total_amount, s.id AS sale_id,
          (SELECT coalesce(sum(si.quantity), 0)
           FROM sale_items AS si WHERE si.sale_id = s.id) AS units
        FROM sale_events AS se
        JOIN sales AS s ON s.id = se.sale_id
        WHERE se.created_at >= ${range.startAt}
          AND se.created_at < ${range.endExclusiveAt}
          AND (${branchId ?? null}::uuid IS NULL OR s.branch_id = ${branchId ?? null}::uuid)
          AND se.event_type IN ('COMPLETED', 'VOIDED')
      ),
      daily AS (
        SELECT (created_at AT TIME ZONE 'Asia/Manila')::date AS business_date,
          coalesce(sum(total_amount) FILTER (WHERE event_type = 'COMPLETED'), 0)::text AS completed_sales_amount,
          count(*) FILTER (WHERE event_type = 'COMPLETED')::int AS completed_sales_count,
          coalesce(sum(total_amount) FILTER (WHERE event_type = 'VOIDED'), 0)::text AS voided_sales_amount,
          count(*) FILTER (WHERE event_type = 'VOIDED')::int AS voided_sales_count,
          coalesce(sum(units) FILTER (WHERE event_type = 'COMPLETED'), 0)::text AS units_sold
        FROM sales_events
        GROUP BY business_date
      )
      SELECT calendar.business_date::text AS date,
        coalesce(daily.completed_sales_amount, '0') AS completed_sales_amount,
        coalesce(daily.completed_sales_count, 0)::int AS completed_sales_count,
        coalesce(daily.voided_sales_amount, '0') AS voided_sales_amount,
        coalesce(daily.voided_sales_count, 0)::int AS voided_sales_count,
        coalesce(daily.units_sold, '0') AS units_sold
      FROM calendar
      LEFT JOIN daily USING (business_date)
      ORDER BY calendar.business_date
    `.execute(this.db);

    return {
      period: { from: range.from, to: range.to, time_zone: 'Asia/Manila' },
      summary,
      sales_trend: trend.rows.map((day) => ({
        ...day,
        completed_sales_amount: normalizeDecimal(day.completed_sales_amount),
        voided_sales_amount: normalizeDecimal(day.voided_sales_amount),
        units_sold: normalizeDecimal(day.units_sold),
      })),
      branches: branchRows.map((branch) => ({
        branch_id: branch.branch_id,
        branch_name: branch.branch_name,
        branch_status: branch.branch_status,
        completed_sales_amount: normalizeDecimal(branch.completed_sales_amount),
        completed_sales_count: branch.completed_sales_count,
        voided_sales_amount: normalizeDecimal(branch.voided_sales_amount),
        voided_sales_count: branch.voided_sales_count,
        units_sold: normalizeDecimal(branch.units_sold),
        submitted_reports_count: branch.submitted_reports_count,
        approved_reports_count: branch.approved_reports_count,
        open_discrepancies_count: branch.open_discrepancies_count,
        in_transit_dispatches_count: branch.in_transit_dispatches_count,
      })),
    };
  }
}

function addDecimal(left: string, right: string): string {
  const [leftWhole, leftFraction = ''] = left.split('.');
  const [rightWhole, rightFraction = ''] = right.split('.');
  const scale = Math.max(leftFraction.length, rightFraction.length);
  const factor = 10n ** BigInt(scale);
  const leftValue =
    BigInt(leftWhole) * factor + BigInt(leftFraction.padEnd(scale, '0') || '0');
  const rightValue =
    BigInt(rightWhole) * factor +
    BigInt(rightFraction.padEnd(scale, '0') || '0');
  const sum = leftValue + rightValue;
  if (scale === 0) return sum.toString();
  const digits = sum.toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, -scale);
  const fraction = digits.slice(-scale).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

function normalizeDecimal(value: string): string {
  const [whole, fraction = ''] = value.split('.');
  const normalizedFraction = fraction.replace(/0+$/, '');
  return normalizedFraction ? `${whole}.${normalizedFraction}` : whole;
}
