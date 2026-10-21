# Recipe stock deduction

Completed POS sales deduct branch stock from each product's recipe. Super Admin maintains recipes in the product form (Products → Edit → Recipe).

## Behavior

- A recipe line is a stock item, a quantity per unit sold (in the stock item's own unit, up to 4 decimals) and when it applies: every sale, Dine-in only or Takeout only. A stock item appears once for every sale or once per service, never both.
- A sale deducts quantity sold × each line that applies to its service, in the same transaction as the sale. Each sale line keeps a consumption snapshot (`sale_item_consumptions`) linked to one `SALE` inventory movement. `sales.inventory_deducted` is true when at least one line deducted stock.
- Sales never fail for low stock. Branch balances may go below zero; Inventory shows them as **Below zero** and the daily count reconciles them. Commissary stock keeps its non-negative rule.
- Products without a recipe still sell and deduct nothing; the Products table shows **No recipe**.
- Recipe changes affect future sales only. A void reverses the sale's saved snapshot exactly (`SALE_VOID`), even after the recipe changed. Carts that mix recipe and no-recipe products void normally.
- Daily reports derive opening, sales usage and expected closing from the ledger, so opening and ledger closing may be negative; physical counts stay non-negative. Approving a report may leave a negative balance when later sales exceed the counted stock.
- Stock items used by an active product's recipe cannot be deactivated until removed from those recipes.
- Each stock item has a recipe use: **Used in recipes** (`RECIPE`) or **Operating supply only** (`OPERATING_SUPPLY`, e.g. cleaning items). Only recipe stock appears in the recipe picker and passes recipe validation; an item in an active recipe can't be switched to operating-only. `GET /stock-items` returns `recipe_use`, filters with `recipe_use=RECIPE|OPERATING_SUPPLY`, and its search matches name or category. Migration `20261021201122_stock_item_recipe_use` marks every item recipe-usable except the Cleaning supplies category; new items default to recipe use.

## API contract

- `GET /products/:id/setup` returns `recipe: [{ stock_item_id, stock_item_name, unit, is_active, usage_scope, quantity }]`. Product rows include `recipe_line_count`.
- `POST /products/setup` and `PUT /products/:id/setup` accept optional `recipe: [{ stock_item_id, quantity, usage_scope }]` (max 50). Omitting it keeps the saved recipe; an array, including `[]`, replaces it and increments `recipe_revision`. Lines must use active stock items and services the product offers; narrowing services is refused while a line targets the removed service.

## Schema

Migration `20261021191412_sales_recipe_deduction` drops `branch_inventory_quantity_nonnegative` and lets `daily_branch_report_items.opening_quantity` and `ledger_closing_quantity` be negative. Its `down` refuses while any negative branch balance or report value exists.

## Release

Back up and verify the target database, apply the migration, deploy the API, then the app. Add recipes before expecting deductions; existing products start with none.
