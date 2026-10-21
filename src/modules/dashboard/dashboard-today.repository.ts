import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { DATABASE } from '../../database/database.module';
import type { DB } from '../../database/db';
import { receivingStatus } from '../dispatches/receiving-policy';

/** Branch IDs the caller may see; null means every branch. */
export type TodayScope = string[] | null;

export const ATTENTION_KEYS = [
  'deliveries_overdue',
  'open_discrepancies',
  'shifts_open_past_day',
  'cash_shortages',
  'stock_below_zero',
  'reports_missing',
  'reports_returned',
  'reports_to_review',
  'late_counts_to_review',
  'shifts_to_review',
  'deliveries_in_transit',
  'products_incomplete_costs',
] as const;
export type AttentionKey = (typeof ATTENTION_KEYS)[number];

const money = (value: RawBuilder<unknown>) =>
  sql`round(${value}, 2)::numeric(14,2)::text`;

@Injectable()
export class DashboardTodayRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DB>) {}

  private scope(scope: TodayScope) {
    const filter =
      scope === null
        ? sql`true`
        : scope.length
          ? sql`id = ANY(${scope}::uuid[])`
          : sql`false`;
    return sql`
      scope AS (SELECT id, branch_name, status FROM branches WHERE ${filter}),
      day AS (SELECT coms_business_date(now()) AS today)
    `;
  }

  async businessDate() {
    const result = await sql<{ today: string; as_of: Date }>`
      SELECT coms_business_date(now())::text AS today, now() AS as_of
    `.execute(this.db);
    return result.rows[0];
  }

  /** Today so far and yesterday up to the same moment. */
  async totals(scope: TodayScope) {
    const result = await sql<{
      net_sales: string;
      sales_count: number;
      average_sale: string | null;
      items_sold: string;
      void_count: number;
      food_cost: string;
      gross_profit: string;
      yesterday_net_sales: string;
      yesterday_sales_count: number;
    }>`
      WITH ${this.scope(scope)},
      today_sales AS (
        SELECT s.id, s.status, s.total_amount FROM sales s
        JOIN scope b ON b.id = s.branch_id, day
        WHERE s.created_at >= coms_business_day_start(day.today)
          AND s.created_at < coms_business_day_end(day.today)
      ),
      completed AS (SELECT * FROM today_sales WHERE status = 'COMPLETED'),
      lines AS (
        SELECT si.quantity,
          coalesce((SELECT sum(x.quantity_consumed * x.unit_cost)
            FROM sale_item_consumptions x WHERE x.sale_item_id = si.id), 0) AS cost
        FROM sale_items si JOIN completed c ON c.id = si.sale_id
      ),
      yesterday AS (
        SELECT s.total_amount FROM sales s
        JOIN scope b ON b.id = s.branch_id, day
        WHERE s.status = 'COMPLETED'
          AND s.created_at >= coms_business_day_start(day.today - 1)
          AND s.created_at < least(now() - interval '1 day', coms_business_day_end(day.today - 1))
      ),
      sums AS (
        SELECT
          (SELECT coalesce(sum(total_amount), 0) FROM completed) AS net_sales,
          (SELECT count(*)::int FROM completed) AS sales_count,
          (SELECT count(*)::int FROM today_sales WHERE status = 'VOIDED') AS void_count,
          (SELECT coalesce(sum(quantity), 0) FROM lines) AS items_sold,
          (SELECT coalesce(sum(cost), 0) FROM lines) AS food_cost,
          (SELECT coalesce(sum(total_amount), 0) FROM yesterday) AS yesterday_net_sales,
          (SELECT count(*)::int FROM yesterday) AS yesterday_sales_count
      )
      SELECT ${money(sql`net_sales`)} AS net_sales, sales_count,
        CASE WHEN sales_count > 0 THEN ${money(sql`net_sales / sales_count`)} END AS average_sale,
        trim_scale(items_sold)::text AS items_sold, void_count,
        ${money(sql`food_cost`)} AS food_cost,
        ${money(sql`net_sales - round(food_cost, 2)`)} AS gross_profit,
        ${money(sql`yesterday_net_sales`)} AS yesterday_net_sales,
        yesterday_sales_count
      FROM sums
    `.execute(this.db);
    return result.rows[0];
  }

  async attention(scope: TodayScope) {
    const result = await sql<Record<AttentionKey, number>>`
      WITH ${this.scope(scope)},
      receiving AS (
        SELECT ${receivingStatus} AS state FROM dispatches d
        JOIN scope b ON b.id = d.branch_id
      )
      SELECT
        (SELECT count(*)::int FROM receiving WHERE state = 'OVERDUE') AS deliveries_overdue,
        (SELECT count(*)::int FROM receiving WHERE state = 'AWAITING_COUNT') AS deliveries_in_transit,
        (SELECT count(*)::int FROM receiving WHERE state = 'REVIEW') AS late_counts_to_review,
        (SELECT count(*)::int FROM dispatch_discrepancies dd
          JOIN dispatches d ON d.id = dd.dispatch_id JOIN scope b ON b.id = d.branch_id
          WHERE dd.status = 'OPEN') AS open_discrepancies,
        (SELECT count(*)::int FROM register_shifts rs JOIN scope b ON b.id = rs.branch_id
          WHERE rs.status = 'CLOSED') AS shifts_to_review,
        (SELECT count(*)::int FROM register_shifts rs JOIN scope b ON b.id = rs.branch_id, day
          WHERE rs.status = 'OPEN' AND rs.business_date < day.today) AS shifts_open_past_day,
        (SELECT count(*)::int FROM register_shifts rs JOIN scope b ON b.id = rs.branch_id, day
          WHERE rs.status IN ('CLOSED', 'REVIEWED') AND rs.cash_difference < 0
            AND rs.business_date > day.today - 7) AS cash_shortages,
        (SELECT count(*)::int FROM branch_inventory bi JOIN scope b ON b.id = bi.branch_id
          WHERE bi.quantity_on_hand < 0) AS stock_below_zero,
        (SELECT count(*)::int FROM daily_branch_reports r JOIN scope b ON b.id = r.branch_id
          WHERE r.status = 'SUBMITTED') AS reports_to_review,
        (SELECT count(*)::int FROM daily_branch_reports r JOIN scope b ON b.id = r.branch_id
          WHERE r.status = 'RETURNED') AS reports_returned,
        (SELECT count(*)::int FROM scope b, day
          WHERE b.status = 'active'
            AND EXISTS (SELECT 1 FROM sales s WHERE s.branch_id = b.id AND s.status = 'COMPLETED'
              AND s.created_at >= coms_business_day_start(day.today - 1)
              AND s.created_at < coms_business_day_end(day.today - 1))
            AND NOT EXISTS (SELECT 1 FROM daily_branch_reports r
              WHERE r.branch_id = b.id AND r.business_date = day.today - 1)) AS reports_missing,
        (SELECT count(*)::int FROM products p WHERE p.is_active AND (
          NOT EXISTS (SELECT 1 FROM product_ingredients r WHERE r.product_id = p.id)
          OR EXISTS (SELECT 1 FROM product_ingredients r
            LEFT JOIN stock_item_costs c ON c.stock_item_id = r.stock_item_id
            WHERE r.product_id = p.id AND c.stock_item_id IS NULL))) AS products_incomplete_costs
    `.execute(this.db);
    return result.rows[0];
  }

  /** Register, sales and yesterday's report for each branch. */
  async branches(scope: TodayScope) {
    const result = await sql<{
      branch_id: string;
      branch_name: string;
      status: string;
      shift_number: number | null;
      cashier_name: string | null;
      opened_at: Date | null;
      sales_count: number;
      net_sales: string;
      last_sale_at: Date | null;
      yesterday_report_status: string | null;
      yesterday_sales_count: number;
    }>`
      WITH ${this.scope(scope)},
      today_sales AS (
        SELECT s.branch_id, s.status, s.total_amount, s.created_at FROM sales s
        JOIN scope b ON b.id = s.branch_id, day
        WHERE s.created_at >= coms_business_day_start(day.today)
          AND s.created_at < coms_business_day_end(day.today)
      ),
      per_branch AS (
        SELECT branch_id,
          count(*) FILTER (WHERE status = 'COMPLETED')::int AS sales_count,
          coalesce(sum(total_amount) FILTER (WHERE status = 'COMPLETED'), 0) AS net_sales,
          max(created_at) AS last_sale_at
        FROM today_sales GROUP BY branch_id
      )
      SELECT b.id AS branch_id, b.branch_name, b.status,
        shift.shift_number, shift.cashier_name, shift.opened_at,
        coalesce(p.sales_count, 0) AS sales_count,
        ${money(sql`coalesce(p.net_sales, 0)`)} AS net_sales,
        p.last_sale_at,
        (SELECT r.status FROM daily_branch_reports r, day
          WHERE r.branch_id = b.id AND r.business_date = day.today - 1) AS yesterday_report_status,
        (SELECT count(*)::int FROM sales s, day WHERE s.branch_id = b.id AND s.status = 'COMPLETED'
          AND s.created_at >= coms_business_day_start(day.today - 1)
          AND s.created_at < coms_business_day_end(day.today - 1)) AS yesterday_sales_count
      FROM scope b
      LEFT JOIN per_branch p ON p.branch_id = b.id
      LEFT JOIN LATERAL (
        SELECT rs.shift_number, u.full_name AS cashier_name, rs.opened_at
        FROM register_shifts rs LEFT JOIN auth.users u ON u.id = rs.opened_by_user_id
        WHERE rs.branch_id = b.id AND rs.status = 'OPEN'
        ORDER BY rs.opened_at DESC LIMIT 1
      ) shift ON true
      WHERE b.status = 'active' OR p.branch_id IS NOT NULL OR shift.shift_number IS NOT NULL
      ORDER BY (shift.shift_number IS NOT NULL) DESC, coalesce(p.net_sales, 0) DESC, b.branch_name
    `.execute(this.db);
    return result.rows;
  }

  async lastSevenDays(scope: TodayScope) {
    const result = await sql<{
      date: string;
      sales_count: number;
      net_sales: string;
      food_cost: string;
      gross_profit: string;
    }>`
      WITH ${this.scope(scope)},
      days AS (
        SELECT (day.today - offs)::date AS business_date FROM day, generate_series(0, 6) AS offs
      ),
      completed AS (
        SELECT s.id, s.total_amount, coms_business_date(s.created_at) AS business_date
        FROM sales s JOIN scope b ON b.id = s.branch_id, day
        WHERE s.status = 'COMPLETED'
          AND s.created_at >= coms_business_day_start(day.today - 6)
          AND s.created_at < coms_business_day_end(day.today)
      ),
      per_sale AS (
        SELECT business_date, count(*)::int AS sales_count, sum(total_amount) AS net_sales
        FROM completed GROUP BY business_date
      ),
      per_cost AS (
        SELECT c.business_date, sum(x.quantity_consumed * x.unit_cost) AS food_cost
        FROM completed c JOIN sale_items si ON si.sale_id = c.id
        JOIN sale_item_consumptions x ON x.sale_item_id = si.id
        GROUP BY c.business_date
      )
      SELECT d.business_date::text AS date,
        coalesce(s.sales_count, 0) AS sales_count,
        ${money(sql`coalesce(s.net_sales, 0)`)} AS net_sales,
        ${money(sql`coalesce(c.food_cost, 0)`)} AS food_cost,
        ${money(sql`coalesce(s.net_sales, 0) - round(coalesce(c.food_cost, 0), 2)`)} AS gross_profit
      FROM days d
      LEFT JOIN per_sale s ON s.business_date = d.business_date
      LEFT JOIN per_cost c ON c.business_date = d.business_date
      ORDER BY d.business_date
    `.execute(this.db);
    return result.rows;
  }

  async topProductsToday(scope: TodayScope) {
    const result = await sql<{
      product_id: string;
      name: string;
      quantity: string;
      net_sales: string;
    }>`
      WITH ${this.scope(scope)}
      SELECT si.product_id,
        (array_agg(si.product_name_snapshot ORDER BY s.created_at DESC))[1] AS name,
        trim_scale(sum(si.quantity))::text AS quantity,
        ${money(sql`sum(si.line_total)`)} AS net_sales
      FROM sales s JOIN scope b ON b.id = s.branch_id
      JOIN sale_items si ON si.sale_id = s.id, day
      WHERE s.status = 'COMPLETED'
        AND s.created_at >= coms_business_day_start(day.today)
        AND s.created_at < coms_business_day_end(day.today)
      GROUP BY si.product_id
      ORDER BY sum(si.line_total) DESC, name
      LIMIT 5
    `.execute(this.db);
    return result.rows;
  }

  branchOptions(scope: TodayScope) {
    if (scope !== null && !scope.length) return Promise.resolve([]);
    let query = this.db
      .selectFrom('branches')
      .select(['id', 'branch_name as name', 'status'])
      .orderBy('branch_name')
      .orderBy('id');
    if (scope !== null) query = query.where('id', 'in', scope);
    return query.execute();
  }
}
