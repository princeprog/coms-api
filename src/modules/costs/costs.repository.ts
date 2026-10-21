import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { DATABASE } from '../../database/database.module';
import type { DB } from '../../database/db';
import { containsSearchPattern } from '../../common/utils/list-filters';
import {
  paginatedResult,
  paginationOffset,
  type Pagination,
} from '../../common/utils/pagination';
import type { CostRange } from './cost-range';

// null = every branch; otherwise the allowed branch ids.
export type BranchScope = string[] | null;

const money = (value: RawBuilder<unknown>) =>
  sql<string>`trim_scale(round(${value}, 2))::text`;

@Injectable()
export class CostsRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DB>) {}

  async productCosts(
    input: Pagination & { search?: string; status?: 'all' | 'incomplete' },
  ) {
    const search = input.search ? containsSearchPattern(input.search) : null;
    const result = await sql<{
      product_id: string;
      product_name: string;
      category_name: string;
      price: string;
      service_types: string[];
      recipe_line_count: number;
      dine_in_cost: string | null;
      takeout_cost: string | null;
      dine_in_margin: string | null;
      takeout_margin: string | null;
      lowest_margin_percent: string | null;
      missing_cost_items: string[];
      total: number;
    }>`
      WITH base AS (
        SELECT p.id, p.product_name, pc.name AS category_name, p.price, p.service_types,
          (SELECT count(*)::int FROM product_ingredients r WHERE r.product_id = p.id) AS recipe_line_count,
          CASE WHEN 'DINE_IN' = ANY(p.service_types) THEN (
            SELECT coalesce(sum(r.quantity_required * c.average_unit_cost), 0)
            FROM product_ingredients r
            LEFT JOIN stock_item_costs c ON c.stock_item_id = r.stock_item_id
            WHERE r.product_id = p.id AND r.usage_scope IN ('ALL', 'DINE_IN')) END AS dine_in_cost,
          CASE WHEN 'TAKEAWAY' = ANY(p.service_types) THEN (
            SELECT coalesce(sum(r.quantity_required * c.average_unit_cost), 0)
            FROM product_ingredients r
            LEFT JOIN stock_item_costs c ON c.stock_item_id = r.stock_item_id
            WHERE r.product_id = p.id AND r.usage_scope IN ('ALL', 'TAKEAWAY')) END AS takeout_cost,
          ARRAY(
            SELECT DISTINCT s.stock_item_name FROM product_ingredients r
            JOIN stock_items s ON s.id = r.stock_item_id
            LEFT JOIN stock_item_costs c ON c.stock_item_id = r.stock_item_id
            WHERE r.product_id = p.id AND c.stock_item_id IS NULL
            ORDER BY s.stock_item_name) AS missing_cost_items
        FROM products p
        JOIN product_categories pc ON pc.id = p.category_id
        WHERE p.is_active
          AND (${search}::text IS NULL OR p.product_name ILIKE ${search}::text)
      ), filtered AS (
        SELECT * FROM base
        WHERE ${input.status ?? 'all'} = 'all'
          OR recipe_line_count = 0 OR cardinality(missing_cost_items) > 0
      )
      SELECT id AS product_id, product_name, category_name, price::text, service_types,
        recipe_line_count,
        ${money(sql`dine_in_cost`)} AS dine_in_cost,
        ${money(sql`takeout_cost`)} AS takeout_cost,
        ${money(sql`price - dine_in_cost`)} AS dine_in_margin,
        ${money(sql`price - takeout_cost`)} AS takeout_margin,
        trim_scale(round(100 * (price - greatest(coalesce(dine_in_cost, 0), coalesce(takeout_cost, 0)))
          / nullif(price, 0), 1))::text AS lowest_margin_percent,
        missing_cost_items,
        count(*) OVER ()::int AS total
      FROM filtered
      ORDER BY product_name, id
      LIMIT ${input.page_size} OFFSET ${paginationOffset(input)}
    `.execute(this.db);
    return this.page(result.rows, input);
  }

  async branchProfit(range: CostRange, scope: BranchScope) {
    const result = await sql<{
      branch_id: string | null;
      branch_name: string;
      sales_count: number;
      net_sales: string;
      food_cost: string;
      gross_profit: string;
      food_cost_percent: string | null;
      cost_coverage_percent: string | null;
      waste_value: string;
      variance_value: string;
    }>`
      WITH ${this.salesCtes(range, scope)},
      branch_sales AS (
        SELECT branch_id, count(*)::int AS sales_count, sum(total_amount) AS net_sales
        FROM sales_in GROUP BY branch_id
      ),
      branch_lines AS (
        SELECT branch_id, sum(cost) AS food_cost,
          coalesce(sum(line_total) FILTER (WHERE costed), 0) AS costed_sales
        FROM lines GROUP BY branch_id
      ),
      branch_reports AS (
        SELECT r.branch_id,
          sum(i.waste_quantity * i.unit_cost) AS waste_value,
          sum(i.variance_quantity * i.unit_cost) AS variance_value
        FROM daily_branch_reports r
        JOIN scope b ON b.id = r.branch_id
        JOIN daily_branch_report_items i ON i.daily_branch_report_id = r.id
        WHERE r.status = 'APPROVED' AND i.unit_cost IS NOT NULL
          AND r.business_date BETWEEN ${range.from}::date AND ${range.to}::date
        GROUP BY r.branch_id
      ),
      per_branch AS (
        SELECT b.id AS branch_id, b.branch_name,
          coalesce(s.sales_count, 0) AS sales_count,
          coalesce(s.net_sales, 0) AS net_sales,
          coalesce(l.food_cost, 0) AS food_cost,
          coalesce(l.costed_sales, 0) AS costed_sales,
          coalesce(rp.waste_value, 0) AS waste_value,
          coalesce(rp.variance_value, 0) AS variance_value
        FROM scope b
        LEFT JOIN branch_sales s ON s.branch_id = b.id
        LEFT JOIN branch_lines l ON l.branch_id = b.id
        LEFT JOIN branch_reports rp ON rp.branch_id = b.id
        WHERE b.status = 'active' OR s.branch_id IS NOT NULL OR rp.branch_id IS NOT NULL
      ),
      rows AS (
        SELECT branch_id, branch_name, sales_count, net_sales, food_cost, costed_sales,
          waste_value, variance_value, 0 AS sort_group FROM per_branch
        UNION ALL
        SELECT NULL, 'All branches', coalesce(sum(sales_count), 0)::int,
          coalesce(sum(net_sales), 0), coalesce(sum(food_cost), 0), coalesce(sum(costed_sales), 0),
          coalesce(sum(waste_value), 0), coalesce(sum(variance_value), 0), 1 FROM per_branch
      )
      SELECT branch_id, branch_name, sales_count,
        ${money(sql`net_sales`)} AS net_sales,
        ${money(sql`food_cost`)} AS food_cost,
        ${money(sql`net_sales - food_cost`)} AS gross_profit,
        trim_scale(round(100 * food_cost / nullif(net_sales, 0), 1))::text AS food_cost_percent,
        trim_scale(round(100 * costed_sales / nullif(net_sales, 0), 1))::text AS cost_coverage_percent,
        ${money(sql`waste_value`)} AS waste_value,
        ${money(sql`variance_value`)} AS variance_value
      FROM rows
      ORDER BY sort_group, branch_name, branch_id
    `.execute(this.db);
    const totals = result.rows.find((row) => row.branch_id === null)!;
    return {
      range,
      totals,
      branches: result.rows.filter((row) => row.branch_id !== null),
    };
  }

  async branchProductProfit(
    range: CostRange,
    scope: BranchScope,
    pagination: Pagination,
  ) {
    const result = await sql<{
      product_id: string;
      product_name: string;
      units_sold: string;
      net_sales: string;
      food_cost: string;
      gross_profit: string;
      food_cost_percent: string | null;
      fully_costed: boolean;
      total: number;
    }>`
      WITH ${this.salesCtes(range, scope)},
      grouped AS (
        SELECT product_id, max(product_name) AS product_name, sum(quantity) AS units_sold,
          sum(line_total) AS net_sales, sum(cost) AS food_cost, bool_and(costed) AS fully_costed
        FROM lines GROUP BY product_id
      )
      SELECT product_id, product_name, trim_scale(units_sold)::text AS units_sold,
        ${money(sql`net_sales`)} AS net_sales,
        ${money(sql`food_cost`)} AS food_cost,
        ${money(sql`net_sales - food_cost`)} AS gross_profit,
        trim_scale(round(100 * food_cost / nullif(net_sales, 0), 1))::text AS food_cost_percent,
        fully_costed,
        count(*) OVER ()::int AS total
      FROM grouped
      ORDER BY net_sales DESC, product_name, product_id
      LIMIT ${pagination.page_size} OFFSET ${paginationOffset(pagination)}
    `.execute(this.db);
    return { range, ...this.page(result.rows, pagination) };
  }

  async stockCosts(
    input: Pagination & { search?: string; missing_only?: boolean },
  ) {
    const search = input.search ? containsSearchPattern(input.search) : null;
    const result = await sql<{
      stock_item_id: string;
      stock_item_name: string;
      category: string;
      unit: string;
      average_unit_cost: string | null;
      last_unit_cost: string | null;
      last_received_at: string | null;
      cost_source: 'RECEIPT' | 'MANUAL' | null;
      updated_at: string | null;
      total: number;
    }>`
      SELECT s.id AS stock_item_id, s.stock_item_name, s.category, s.unit,
        trim_scale(round(c.average_unit_cost, 4))::text AS average_unit_cost,
        trim_scale(c.last_unit_cost)::text AS last_unit_cost,
        c.last_received_at, c.cost_source, c.updated_at,
        count(*) OVER ()::int AS total
      FROM stock_items s
      LEFT JOIN stock_item_costs c ON c.stock_item_id = s.id
      WHERE s.is_active
        AND (${search}::text IS NULL OR s.stock_item_name ILIKE ${search}::text OR s.category ILIKE ${search}::text)
        AND (NOT ${input.missing_only ?? false}::boolean OR c.stock_item_id IS NULL)
      ORDER BY s.stock_item_name, s.id
      LIMIT ${input.page_size} OFFSET ${paginationOffset(input)}
    `.execute(this.db);
    return this.page(result.rows, input);
  }

  async setStockCost(
    stockItemId: string,
    unitCost: string,
    actorUserId: string,
  ) {
    return this.db.transaction().execute(async (tx) => {
      const stock = await tx
        .selectFrom('stock_items')
        .select(['id', 'stock_item_name', 'is_active'])
        .where('id', '=', stockItemId)
        .forShare()
        .executeTakeFirst();
      if (!stock?.is_active)
        throw new NotFoundException('Active stock item not found');
      const previous = await tx
        .selectFrom('stock_item_costs')
        .select(sql<string>`trim_scale(average_unit_cost)::text`.as('cost'))
        .where('stock_item_id', '=', stockItemId)
        .forUpdate()
        .executeTakeFirst();
      await tx
        .insertInto('stock_item_costs')
        .values({
          stock_item_id: stockItemId,
          average_unit_cost: unitCost,
          cost_source: 'MANUAL',
          updated_by_user_id: actorUserId,
        })
        .onConflict((c) =>
          c.column('stock_item_id').doUpdateSet({
            average_unit_cost: unitCost,
            cost_source: 'MANUAL',
            updated_by_user_id: actorUserId,
            updated_at: sql<Date>`now()`,
          }),
        )
        .execute();
      return {
        stock_item_id: stock.id,
        stock_item_name: stock.stock_item_name,
        previous_cost: previous?.cost ?? null,
        average_unit_cost: unitCost,
        cost_source: 'MANUAL' as const,
      };
    });
  }

  // Completed (not voided) sales by business date, and their lines with food
  // cost. A line is fully costed only when every consumption has a cost.
  private salesCtes(range: CostRange, scope: BranchScope) {
    const branchFilter =
      scope === null
        ? sql`true`
        : scope.length
          ? sql`id IN (${sql.join(scope.map((id) => sql`${id}::uuid`))})`
          : sql`false`;
    return sql`
      scope AS (SELECT id, branch_name, status FROM branches WHERE ${branchFilter}),
      sales_in AS (
        SELECT s.id, s.branch_id, s.total_amount FROM sales s
        JOIN scope b ON b.id = s.branch_id
        WHERE s.status = 'COMPLETED'
          AND s.created_at >= coms_business_day_start(${range.from}::date)
          AND s.created_at < coms_business_day_end(${range.to}::date)
      ),
      lines AS (
        SELECT si.id, si.product_id, p.product_name, si.quantity, si.line_total, sa.branch_id,
          coalesce((SELECT sum(c.quantity_consumed * c.unit_cost) FROM sale_item_consumptions c
            WHERE c.sale_item_id = si.id), 0) AS cost,
          EXISTS (SELECT 1 FROM sale_item_consumptions c WHERE c.sale_item_id = si.id)
            AND NOT EXISTS (SELECT 1 FROM sale_item_consumptions c
              WHERE c.sale_item_id = si.id AND c.unit_cost IS NULL) AS costed
        FROM sale_items si
        JOIN sales_in sa ON sa.id = si.sale_id
        JOIN products p ON p.id = si.product_id
      )
    `;
  }

  private page<T extends { total: number }>(rows: T[], input: Pagination) {
    const total = rows[0]?.total ?? 0;
    return paginatedResult(
      rows.map(({ total: _total, ...row }) => row),
      total,
      input,
    );
  }
}
