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

## Local starter data — 2026-10-26

At the user's request, added missing levels for 12 active items at the commissary and each of the eight active branches: 108 new location settings. These are starter/demo values appropriate to the existing sample stock units, not demand forecasts; most branches have no recent usage history. All eight branches use the branch values below and can be tuned separately through Inventory → Levels.

| Item | Unit | Commissary reorder / target | Branch reorder / target |
| --- | --- | --- | --- |
| Chicken Leg Quarter | kg | 60 / 180 | 8 / 20 |
| Marinated Chicken Inasal | portion | 240 / 720 | 40 / 100 |
| Dinorado Rice | kg | 200 / 600 | 25 / 60 |
| Cooking Oil | L | 60 / 200 | 5 / 15 |
| Beef Tapa - Marinated | kg | 20 / 75 | 3 / 8 |
| Pork Sisig Mix | kg | 25 / 90 | 4 / 10 |
| Lumpiang Shanghai - Frozen | pcs | 600 / 2400 | 100 / 250 |
| Chicken Eggs - Large | pcs | 600 / 1800 | 90 / 180 |
| Bottled Water 500ml | bottle | 240 / 1200 | 48 / 120 |
| Cola 330ml | can | 144 / 720 | 24 / 72 |
| Kraft Meal Box 750ml | pcs | 1500 / 5000 | 200 / 500 |
| Wooden Spoon and Fork Set | set | 1500 / 5000 | 200 / 500 |

Applied only to localhost/coms-db in a single transaction, skipping existing settings. The previous Boneless Bangus commissary setting remains 50 / 2000. Each insertion records stock_item.levels_set with a local sample-data source and no staff impersonation. A pre-change levels snapshot is retained outside the repositories and vault.

Verified through the inventory repository queries: 13 configured commissary items and 12 in each active branch. At application time, six branch item/location pairs show LOW (one Manila - Ermita, one Taguig - BGC Express, four Marikina - Concepcion Express). Stock balances and movement count are unchanged; all targets exceed reorder levels. No schema, application-code or production-data change.
