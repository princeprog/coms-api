# Dashboard (today)

`GET /dashboard/today?branch_id=` powers the app's Dashboard: today's business day so far and what needs attention. It requires `dashboard.read`. Super Admin and `dashboard.global_read` see every branch; others see their assigned branches (403 for another branch or none assigned).

## Response

- `business_date`, `as_of`, `scope_label`, `branch_options`, `show_costs`.
- `today`: net sales, sales count, average sale, items sold, voids, food cost and gross profit (null without Super Admin or `costs.read`).
- `yesterday_same_time` and `changes`: completed sales from yesterday's business-day start up to exactly one day ago, with percent change (null when yesterday had none).
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
| shifts_to_review | Closed shifts not yet reviewed | shifts.read |
| shifts_open_past_day | Shifts still open from an earlier business day | shifts.read |
| cash_shortages | Closed shifts short of cash in the last 7 business days | shifts.read |
| stock_below_zero | Branch stock rows below zero | inventory.read |
| reports_to_review / reports_returned | Daily reports submitted / returned | daily_reports.read |
| reports_missing | Branches that sold yesterday without a report | daily_reports.read |
| products_incomplete_costs | Active products without a recipe or with uncosted stock (all branches) | costs.read |

Receiving states reuse the Dispatches page rule (`receivingStatus`), so counts match its Overdue, Awaiting count and Review views. The older `/dashboard/overview` and `/branches/:id/dashboard` endpoints are unchanged.

