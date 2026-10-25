# Stock costing and profit

COMS values stock at one company-wide weighted-average cost per stock item and reports food cost and gross profit from recipe deductions. The Costs & profit page and its `/costs` API were retired on 2026-10-25; profit now appears on the Sales report and Dashboard.

## How cost is kept

- Supplier deliveries and direct purchases update the average inside the posting transaction: `(max(on_hand, 0) × average + quantity × unit cost) / (max(on_hand, 0) + quantity)`, using commissary stock before the receipt. The first receipt sets the average.
- Costs cannot be set by hand. Earlier manual costs (`cost_source = 'MANUAL'`) and sample-data costs stay until a receipt blends into them.
- A sale copies the current average onto each recipe consumption line; approving a daily report copies it onto each item. Later cost changes never rewrite recorded profit. Sales recorded before costs existed show no food cost.

## Access

`costs.read` shows food cost and profit for assigned branches on the Sales report and Dashboard; `costs.global_read` covers all branches. No role receives them by default; Super Admin sees everything. Migration `20261025142153_retire_costs_manage_permission` removes the former `costs.manage` permission and its grants.

## Storage

Migration `20261021204146_stock_costing` adds `stock_item_costs`, the cost snapshots and the permissions; it backfills averages from receipt history. Sample data (`pnpm seed:philippines`) sets typical unit costs for sample stock without a cost.
