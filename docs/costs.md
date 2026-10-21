# Costs and profit

COMS values stock at one company-wide weighted-average cost per stock item and reports food cost and gross profit from recipe deductions.

## How cost is kept

- Supplier deliveries and direct purchases update the average inside the posting transaction: `(max(on_hand, 0) × average + quantity × unit cost) / (max(on_hand, 0) + quantity)`, using commissary stock before the receipt. The first receipt sets the average.
- Users with `costs.manage` can set a cost by hand (with a reason) for items never purchased, such as commissary preparations. Later receipts blend into it.
- A sale copies the current average onto each recipe consumption line; approving a daily report copies it onto each item. Later cost changes never rewrite recorded profit. Sales recorded before costs existed show no food cost.

## Reports (`/costs`)

- **Profit**: net sales (completed, not voided) by business date, food cost, gross profit, food-cost %, costed-sales coverage, and approved-report waste and count-variance value, per branch with totals, plus profit by product.
- **Product costs**: recipe cost for Dine-in and Takeout at today's average cost, margins, and flags for "No recipe" or "Missing cost" with the item names.
- **Stock costs**: average cost, last receipt cost and source per stock item; "Set cost" for `costs.manage`.

## Access

`costs.read` shows assigned branches; `costs.global_read` shows all; `costs.manage` sets costs. No role receives them by default; Super Admin sees everything. Grant them in Roles.

## API

`GET /costs/products`, `GET /costs/branches?from&to`, `GET /costs/branch-products?from&to&branch_id`, `GET /costs/stock-items`, `PUT /costs/stock-items/:id { unit_cost, reason }`. Migration `20261021204146_stock_costing` adds `stock_item_costs`, the cost snapshots and the permissions; it backfills averages from receipt history. Sample data (`pnpm seed:philippines`) sets typical unit costs for sample stock without a cost.
