# Stock levels (reorder point and target)

Each stock item can have a **reorder level** and a **target level** at the commissary and at each branch (`stock_levels`, migration `20261022011942_stock_levels`). Items without levels never raise low-stock alerts.

## Rules

- Levels are decimal strings, zero or more, with up to 3 decimal places. The target must be more than the reorder level. Sending `null` for both clears them.
- **On the way** (branch only) is the quantity in `IN_TRANSIT` dispatches the branch has not counted. Drafts are not counted. The commissary has no on-the-way stock.
- An item **needs restocking** when it is active, has levels, and on hand + on the way is at or below the reorder level.
- `stock_status` on inventory lists, first match wins: `INACTIVE`, `BELOW_ZERO`, `OUT_OF_STOCK`, `LOW` (needs restocking), `RESTOCKING` (on hand is at or below the reorder level but stock on the way lifts it above), `IN_STOCK`.
- `avg_daily_use` is the last 14 days divided by 14: net sales deductions at a branch, net dispatches out at the commissary.

The SQL fragments live in `src/modules/inventory/stock-position.ts` and are shared by inventory lists, dispatch suggestions and the dashboard.

## Endpoints

| Method and path | Permission | Notes |
| --- | --- | --- |
| `PUT /inventory/levels` | `inventory.levels_manage` | Body `{ stock_item_id, scope: 'COMMISSARY' \| 'BRANCH', branch_ids?, reorder_level, target_level }`. Branch scope needs 1–500 active branches; non–Super Admins only their assigned branches. One transaction; unchanged locations are skipped. Returns `{ stock_item_id, reorder_level, target_level, locations, changed }`. |
| `GET /inventory/commissary`, `GET /inventory/branches/:branchId` | existing | Items add `reorder_level`, `target_level`, `on_the_way`, `avg_daily_use`, `stock_status`. `stock=low` keeps items that need restocking. CSV exports add Reorder level, Target level and Status. |
| `GET /dispatches/restock-suggestions?branch_id=` | `dispatches.create` + branch scope | Items needing restocking at an active branch: `on_hand`, `on_the_way`, levels, `suggested_quantity` (target − on hand − on the way), `quantity_to_send` (suggestion capped at commissary stock, never below 0) and `commissary_available` (null without `inventory.commissary_read`). Below-zero items first, then lowest on hand ÷ target. |

## Access and audit

`inventory.levels_manage` is granted to the predefined Commissary Manager role; Super Admin always has it. Each changed location writes a `stock_item.levels_set` or `stock_item.levels_cleared` audit event with the from/to levels, the branch and a `location` label.
