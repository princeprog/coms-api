import { sql, type RawBuilder } from 'kysely';

export type StockStatus =
  | 'INACTIVE'
  | 'BELOW_ZERO'
  | 'OUT_OF_STOCK'
  | 'LOW'
  | 'RESTOCKING'
  | 'IN_STOCK';

type Expr = RawBuilder<unknown>;

/**
 * Quantity sent to a branch that the branch has not counted yet. Counted
 * dispatches are already in branch stock; drafts are not on the way.
 */
export function onTheWaySql(branchId: Expr, stockItemId: Expr) {
  return sql<string>`(SELECT coalesce(sum(di.quantity_dispatched), 0)
    FROM dispatch_items di JOIN dispatches d ON d.id = di.dispatch_id
    WHERE d.branch_id = ${branchId} AND di.stock_item_id = ${stockItemId}
      AND d.status = 'IN_TRANSIT' AND d.counted_at IS NULL)`;
}

/**
 * An item needs restocking when its stock position (on hand plus on the way)
 * is at or below its reorder level. Items without levels never do.
 */
export function needsRestockSql(onHand: Expr, onTheWay: Expr, reorder: Expr) {
  return sql<boolean>`(${reorder} IS NOT NULL AND ${onHand} + ${onTheWay} <= ${reorder})`;
}

export function stockStatusSql(input: {
  active: Expr;
  onHand: Expr;
  onTheWay: Expr;
  reorder: Expr;
}) {
  const { active, onHand, onTheWay, reorder } = input;
  return sql<StockStatus>`CASE
    WHEN NOT ${active} THEN 'INACTIVE'
    WHEN ${onHand} < 0 THEN 'BELOW_ZERO'
    WHEN ${onHand} = 0 THEN 'OUT_OF_STOCK'
    WHEN ${needsRestockSql(onHand, onTheWay, reorder)} THEN 'LOW'
    WHEN ${reorder} IS NOT NULL AND ${onHand} <= ${reorder} THEN 'RESTOCKING'
    ELSE 'IN_STOCK' END`;
}
