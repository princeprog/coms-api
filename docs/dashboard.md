# Dashboard (today)

`GET /dashboard/today?branch_id=` powers the app's Dashboard: today's business day so far and what needs attention. It requires `dashboard.read`. Super Admin and `dashboard.global_read` see every branch; others see their assigned branches (403 for another branch or none assigned).

## Response

- `business_date`, `as_of`, `scope_label`, `branch_options`, `show_costs`.
- `today`: net sales, sales count, average sale, items sold, voids, food cost, gross profit and `cost_coverage_percent` (share of net sales whose recipe cost is known; the cost fields are null without Super Admin or `costs.read`).
- `last_week_same_time` and `yesterday_same_time`: completed sales from that business day's start up to exactly 7 days / 1 day ago. `changes.net_sales` and `changes.sales_count` compare with the same weekday last week (fairer for restaurant weekly patterns); `changes.net_sales_vs_yesterday` keeps the yesterday view. Null when the earlier period had no sales.
- `hourly[]`: net sales and sales count per Manila clock hour from the business-day start to now, with `last_week_net_sales` for the same hours last week.
- `attention[]`: `{ key, count }` for every item the user may see; zero counts included.
- `branches[]`: open shift (number, cashier, opened at), today's sales and net sales, last sale time, and yesterday's report status — `MISSING` when the branch sold something yesterday and has no report.
- `last_7_days[]` (today − 6 to today) and `top_products_today[]` (top 5 by net sales).

## Attention items

| Key | Counts | Permission |
| --- | --- | --- |
| deliveries_overdue | Dispatches past their receive-by time and not counted | dispatches.read |
| deliveries_in_transit | Dispatches awaiting a count, not yet due | dispatches.read |
| late_counts_to_review | Late counts waiting for review | dispatches.read |
| open_discrepancies | Open dispatch discrepancies | dispatches.read |
| dispatches_draft | Dispatches drafted but not sent | dispatches.dispatch |
| shifts_to_review | Closed shifts not yet reviewed | shifts.read |
| shifts_open_past_day | Shifts still open from an earlier business day | shifts.read |
| cash_shortages | Closed shifts short of cash in the last 7 business days | shifts.read |
| stock_below_zero | Branch stock rows below zero | inventory.read |
| branch_stock_low | Branch items at or below their reorder level, counting stock on the way (see stock-levels.md) | inventory.read |
| commissary_stock_low | Commissary items at or below their reorder level; 0 when the dashboard is filtered to a branch | inventory.commissary_read |
| reports_to_review / reports_returned | Daily reports submitted / returned | daily_reports.read |
| reports_missing | Branches that sold yesterday without a report | daily_reports.read |
| products_incomplete_costs | Active products without a recipe or with uncosted stock (all branches) | costs.read |

Receiving states reuse the Dispatches page rule (`receivingStatus`), so counts match its Overdue, Awaiting count and Review views. The older `/dashboard/overview` and `/branches/:id/dashboard` endpoints are unchanged.

