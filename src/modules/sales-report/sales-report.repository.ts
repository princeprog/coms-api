import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { DATABASE } from '../../database/database.module';
import type { DB } from '../../database/db';
import type { DateRange } from './sales-report-period';

/** Branch IDs the caller may see; null means every branch. */
export type ReportScope = string[] | null;

export type ReportTotals = {
  gross_sales: string;
  net_sales: string;
  sales_count: number;
  average_sale: string | null;
  items_sold: string;
  void_count: number;
  void_amount: string;
  food_cost: string;
  gross_profit: string;
  food_cost_percent: string | null;
  cost_coverage_percent: string | null;
};

const money = (value: RawBuilder<unknown>) =>
  sql`round(${value}, 2)::numeric(14,2)::text`;
const percent = (part: RawBuilder<unknown>, whole: RawBuilder<unknown>) =>
  sql`trim_scale(round(100 * ${part} / nullif(${whole}, 0), 1))::text`;

@Injectable()
export class SalesReportRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DB>) {}

  // Completed and voided sales by business day, with recipe cost per line.
  private ctes(range: DateRange, scope: ReportScope) {
    const branchFilter =
      scope === null
        ? sql`true`
        : scope.length
          ? sql`id = ANY(${scope}::uuid[])`
          : sql`false`;
    return sql`
      scope AS (SELECT id, branch_name, code, status FROM branches WHERE ${branchFilter}),
      sales_in AS (
        SELECT s.id, s.branch_id, s.status, s.total_amount, s.tender_method,
          s.service_type, coms_business_date(s.created_at) AS business_date
        FROM sales s
        JOIN scope b ON b.id = s.branch_id
        WHERE s.created_at >= coms_business_day_start(${range.from}::date)
          AND s.created_at < coms_business_day_end(${range.to}::date)
      ),
      completed AS (SELECT * FROM sales_in WHERE status = 'COMPLETED'),
      lines AS (
        SELECT si.id, si.product_id, si.product_name_snapshot, si.quantity,
          si.line_total, c.branch_id, c.business_date, p.category_id,
          coalesce((SELECT sum(x.quantity_consumed * x.unit_cost)
            FROM sale_item_consumptions x WHERE x.sale_item_id = si.id), 0) AS cost,
          EXISTS (SELECT 1 FROM sale_item_consumptions x WHERE x.sale_item_id = si.id)
            AND NOT EXISTS (SELECT 1 FROM sale_item_consumptions x
              WHERE x.sale_item_id = si.id AND x.unit_cost IS NULL) AS costed
        FROM sale_items si
        JOIN completed c ON c.id = si.sale_id
        JOIN products p ON p.id = si.product_id
      )
    `;
  }

  async totals(range: DateRange, scope: ReportScope) {
    const result = await sql<ReportTotals>`
      WITH ${this.ctes(range, scope)},
      sums AS (
        SELECT
          (SELECT coalesce(sum(total_amount), 0) FROM sales_in) AS gross_sales,
          (SELECT coalesce(sum(total_amount), 0) FROM completed) AS net_sales,
          (SELECT count(*)::int FROM completed) AS sales_count,
          (SELECT coalesce(sum(quantity), 0) FROM lines) AS items_sold,
          (SELECT count(*)::int FROM sales_in WHERE status = 'VOIDED') AS void_count,
          (SELECT coalesce(sum(total_amount), 0) FROM sales_in WHERE status = 'VOIDED') AS void_amount,
          (SELECT coalesce(sum(cost), 0) FROM lines) AS food_cost,
          (SELECT coalesce(sum(line_total) FILTER (WHERE costed), 0) FROM lines) AS costed_sales
      )
      SELECT ${money(sql`gross_sales`)} AS gross_sales,
        ${money(sql`net_sales`)} AS net_sales,
        sales_count,
        CASE WHEN sales_count > 0 THEN ${money(sql`net_sales / sales_count`)} END AS average_sale,
        trim_scale(items_sold)::text AS items_sold,
        void_count,
        ${money(sql`void_amount`)} AS void_amount,
        ${money(sql`food_cost`)} AS food_cost,
        ${money(sql`net_sales - round(food_cost, 2)`)} AS gross_profit,
        ${percent(sql`food_cost`, sql`net_sales`)} AS food_cost_percent,
        ${percent(sql`costed_sales`, sql`net_sales`)} AS cost_coverage_percent
      FROM sums
    `.execute(this.db);
    return result.rows[0];
  }

  async breakdowns(range: DateRange, scope: ReportScope) {
    const run = <T>(query: RawBuilder<unknown>) =>
      sql<T>`WITH ${this.ctes(range, scope)} ${query}`
        .execute(this.db)
        .then((result) => result.rows);
    const [byBranch, byPayment, byService, byCategory, topProducts, daily] =
      await Promise.all([
        run<{
          branch_id: string;
          branch_name: string;
          sales_count: number;
          net_sales: string;
          average_sale: string | null;
          food_cost: string;
          gross_profit: string;
          cash_difference: string;
        }>(sql`,
          per_sale AS (
            SELECT branch_id, count(*)::int AS sales_count, sum(total_amount) AS net_sales
            FROM completed GROUP BY branch_id
          ),
          per_cost AS (SELECT branch_id, sum(cost) AS food_cost FROM lines GROUP BY branch_id),
          per_cash AS (
            SELECT rs.branch_id, sum(rs.cash_difference) AS cash_difference
            FROM register_shifts rs JOIN scope b ON b.id = rs.branch_id
            WHERE rs.status IN ('CLOSED', 'REVIEWED')
              AND rs.business_date BETWEEN ${range.from}::date AND ${range.to}::date
            GROUP BY rs.branch_id
          )
          SELECT b.id AS branch_id, b.branch_name,
            coalesce(s.sales_count, 0) AS sales_count,
            ${money(sql`coalesce(s.net_sales, 0)`)} AS net_sales,
            CASE WHEN s.sales_count > 0 THEN ${money(sql`s.net_sales / s.sales_count`)} END AS average_sale,
            ${money(sql`coalesce(c.food_cost, 0)`)} AS food_cost,
            ${money(sql`coalesce(s.net_sales, 0) - round(coalesce(c.food_cost, 0), 2)`)} AS gross_profit,
            ${money(sql`coalesce(k.cash_difference, 0)`)} AS cash_difference
          FROM scope b
          LEFT JOIN per_sale s ON s.branch_id = b.id
          LEFT JOIN per_cost c ON c.branch_id = b.id
          LEFT JOIN per_cash k ON k.branch_id = b.id
          WHERE b.status = 'active' OR s.branch_id IS NOT NULL OR k.branch_id IS NOT NULL
          ORDER BY coalesce(s.net_sales, 0) DESC, b.branch_name, b.id
        `),
        run<{
          name: string;
          sales_count: number;
          amount: string;
          share_percent: string | null;
        }>(sql`
          SELECT mode() WITHIN GROUP (ORDER BY tender_method) AS name,
            count(*)::int AS sales_count,
            ${money(sql`sum(total_amount)`)} AS amount,
            ${percent(sql`sum(total_amount)`, sql`(SELECT sum(total_amount) FROM completed)`)} AS share_percent
          FROM completed GROUP BY lower(trim(tender_method))
          ORDER BY sum(total_amount) DESC, name
        `),
        run<{
          service_type: string;
          sales_count: number;
          amount: string;
          share_percent: string | null;
        }>(sql`
          SELECT service_type, count(*)::int AS sales_count,
            ${money(sql`sum(total_amount)`)} AS amount,
            ${percent(sql`sum(total_amount)`, sql`(SELECT sum(total_amount) FROM completed)`)} AS share_percent
          FROM completed GROUP BY service_type ORDER BY sum(total_amount) DESC, service_type
        `),
        run<{
          name: string;
          quantity: string;
          net_sales: string;
          food_cost: string;
          gross_profit: string;
          share_percent: string | null;
        }>(sql`
          SELECT coalesce(pc.name, 'Uncategorized') AS name,
            trim_scale(sum(l.quantity))::text AS quantity,
            ${money(sql`sum(l.line_total)`)} AS net_sales,
            ${money(sql`sum(l.cost)`)} AS food_cost,
            ${money(sql`sum(l.line_total) - round(sum(l.cost), 2)`)} AS gross_profit,
            ${percent(sql`sum(l.line_total)`, sql`(SELECT sum(line_total) FROM lines)`)} AS share_percent
          FROM lines l LEFT JOIN product_categories pc ON pc.id = l.category_id
          GROUP BY pc.name ORDER BY sum(l.line_total) DESC, pc.name
        `),
        run<{
          product_id: string;
          name: string;
          quantity: string;
          net_sales: string;
          food_cost: string;
          gross_profit: string;
        }>(sql`
          SELECT l.product_id,
            (array_agg(l.product_name_snapshot ORDER BY l.business_date DESC))[1] AS name,
            trim_scale(sum(l.quantity))::text AS quantity,
            ${money(sql`sum(l.line_total)`)} AS net_sales,
            ${money(sql`sum(l.cost)`)} AS food_cost,
            ${money(sql`sum(l.line_total) - round(sum(l.cost), 2)`)} AS gross_profit
          FROM lines l GROUP BY l.product_id
          ORDER BY sum(l.line_total) DESC, name LIMIT 10
        `),
        run<{
          date: string;
          sales_count: number;
          net_sales: string;
          food_cost: string;
          gross_profit: string;
        }>(sql`,
          days AS (
            SELECT d::date AS business_date
            FROM generate_series(${range.from}::date, ${range.to}::date, interval '1 day') AS d
          ),
          per_sale AS (
            SELECT business_date, count(*)::int AS sales_count, sum(total_amount) AS net_sales
            FROM completed GROUP BY business_date
          ),
          per_cost AS (SELECT business_date, sum(cost) AS food_cost FROM lines GROUP BY business_date)
          SELECT d.business_date::text AS date,
            coalesce(s.sales_count, 0) AS sales_count,
            ${money(sql`coalesce(s.net_sales, 0)`)} AS net_sales,
            ${money(sql`coalesce(c.food_cost, 0)`)} AS food_cost,
            ${money(sql`coalesce(s.net_sales, 0) - round(coalesce(c.food_cost, 0), 2)`)} AS gross_profit
          FROM days d
          LEFT JOIN per_sale s ON s.business_date = d.business_date
          LEFT JOIN per_cost c ON c.business_date = d.business_date
          ORDER BY d.business_date
        `),
      ]);
    return { byBranch, byPayment, byService, byCategory, topProducts, daily };
  }

  async cashAndStock(range: DateRange, scope: ReportScope) {
    const result = await sql<{
      closed_shifts: number;
      short_shifts: number;
      over_shifts: number;
      cash_difference: string;
      short_amount: string;
      over_amount: string;
      waste_value: string;
      variance_value: string;
      approved_reports: number;
    }>`
      WITH ${this.ctes(range, scope)},
      shifts AS (
        SELECT rs.cash_difference FROM register_shifts rs
        JOIN scope b ON b.id = rs.branch_id
        WHERE rs.status IN ('CLOSED', 'REVIEWED')
          AND rs.business_date BETWEEN ${range.from}::date AND ${range.to}::date
      ),
      reports AS (
        SELECT r.id FROM daily_branch_reports r JOIN scope b ON b.id = r.branch_id
        WHERE r.status = 'APPROVED'
          AND r.business_date BETWEEN ${range.from}::date AND ${range.to}::date
      ),
      report_values AS (
        SELECT coalesce(sum(i.waste_quantity * i.unit_cost), 0) AS waste_value,
          coalesce(sum(i.variance_quantity * i.unit_cost), 0) AS variance_value
        FROM daily_branch_report_items i JOIN reports r ON r.id = i.daily_branch_report_id
        WHERE i.unit_cost IS NOT NULL
      )
      SELECT
        (SELECT count(*)::int FROM shifts) AS closed_shifts,
        (SELECT count(*)::int FROM shifts WHERE cash_difference < 0) AS short_shifts,
        (SELECT count(*)::int FROM shifts WHERE cash_difference > 0) AS over_shifts,
        ${money(sql`(SELECT coalesce(sum(cash_difference), 0) FROM shifts)`)} AS cash_difference,
        ${money(sql`(SELECT coalesce(sum(cash_difference), 0) FROM shifts WHERE cash_difference < 0)`)} AS short_amount,
        ${money(sql`(SELECT coalesce(sum(cash_difference), 0) FROM shifts WHERE cash_difference > 0)`)} AS over_amount,
        ${money(sql`(SELECT waste_value FROM report_values)`)} AS waste_value,
        ${money(sql`(SELECT variance_value FROM report_values)`)} AS variance_value,
        (SELECT count(*)::int FROM reports) AS approved_reports
    `.execute(this.db);
    return result.rows[0];
  }

  branchOptions(scope: ReportScope) {
    if (scope !== null && !scope.length) return Promise.resolve([]);
    let query = this.db
      .selectFrom('branches')
      .select(['id', 'branch_name as name', 'code', 'status'])
      .orderBy('branch_name')
      .orderBy('id');
    if (scope !== null) query = query.where('id', 'in', scope);
    return query.execute();
  }

  async userName(userId: string) {
    const user = await this.db
      .selectFrom('auth.users')
      .select('full_name')
      .where('id', '=', userId)
      .executeTakeFirst();
    return user?.full_name ?? 'COMS user';
  }
}
