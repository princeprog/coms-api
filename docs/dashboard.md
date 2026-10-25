# Dashboard (today)

`GET /dashboard/today?branch_id=` powers the app's Dashboard: today's business day so far and what needs attention. It requires `dashboard.read`. Super Admin and `dashboard.global_read` see every branch; others see their assigned branches (403 for another branch or none assigned).

## Response

- `business_date`, `as_of`, `scope_label`, `branch_options`, `show_costs`.
- `today`: net sales, sales count, average sale, items sold, voids, food cost, gross profit and `cost_coverage_percent` (share of net sales whose recipe cost is known; the cost fields are null without Super Admin or `costs.read`).
- `last_week_same_time` and `yesterday_same_time`: completed sales from that business day's start up to exactly 7 days / 1 day ago. `changes.net_sales` and `changes.sales_count` compare with the same weekday last week (fairer for restaurant weekly patterns); `changes.net_sales_vs_yesterday` keeps the yesterday view. Null when the earlier period had no sales.
- `hourly[]`: net sales and sales count per Manila clock hour from the business-day start to now, with `last_week_net_sales` for the same hours last week.
- `workspace`: `overview` for Super Admin/global dashboard readers, `branch` for assigned-branch readers. `access` exposes report, shift, sales-report and dispatch read capabilities for navigation.
- `attention[]`: `{ key, count, branch_count, oldest_at, amount, example }` for every permitted category, including zero counts. The oldest example carries its record/branch IDs, branch name, optional label and exact quantity/unit. `amount` is the summed cash shortage, expressed as a positive decimal string; stock quantities are never added across different items or units. Empty categories have null details. Category counts and examples come from the same scoped query.
- `branches[]`: open shift (ID, number, cashier, opened at), today's sales and net sales, `last_week_net_sales` (completed sales from the start of the same weekday last week up to exactly 7 days ago, matching `last_week_same_time`) and `net_sales_change` (null when last week had no sales), last sale time, and yesterday's report status — `MISSING` when the branch sold something yesterday and has no report. Shift IDs require `shifts.read`; report statuses require `daily_reports.read`. Returned reports come first, then submitted reports, then yesterday's unfinished reports. Ties retain register/sales ordering.
- `report_progress[]`: today's and yesterday's report per active/operating branch, only with `daily_reports.read`. Includes date, report ID, status, saved total/count-completed items, open/unreviewed shifts, pending deliveries, pending arrived counts and whether the business day has ended. Missing reports have null item totals; existing empty reports have zero. Counts use saved report membership, so later daily-count policy changes do not rewrite progress. Pending deliveries need counting or an explanation; arrived counts require review. These are checklist indicators, not a promise that submission or approval will succeed.
- `submission_checklist_bypassed`: true only in API development mode, used to label the checklist consistently with the report workspace.
- `count_shortages`: with `daily_reports.read`, shortages from SUBMITTED and APPROVED reports dated within the last `days` (7) business days before today. A shortage is a report item whose physical count is below expected closing (negative variance after recorded waste and justified adjustments); surpluses are excluded. `branches[]` gives each branch's report count, short count lines, uncosted short lines and total shortage value. `items[]` lists up to 8 branch/item pairs ordered by value, then by how many reports were short, with exact summed quantity and unit, `times_short` and the latest report. Values use the report's saved unit cost, else the current average cost; an item value is null when any of its lines lacks a cost. Values are null without `costs.read`. Shortages are investigation signals: they can come from theft, unrecorded sales, waste, recipe errors or miscounts.
- `report_backlog`: with `daily_reports.read`, unfinished reports dated before yesterday (DRAFT or RETURNED, any age) plus days within the last 14 business days on which an active branch completed sales without starting a report. Oldest first, up to 10 rows, with `total` for all matches and `days_outstanding`. Today and yesterday stay in `report_progress`.
- `last_7_days[]` (today − 6 to today) and `top_products_today[]` (top 5 by net sales).

## Attention items

| Key                                  | Counts                                                                                         | Permission                |
| ------------------------------------ | ---------------------------------------------------------------------------------------------- | ------------------------- |
| deliveries_overdue                   | Dispatches past their receive-by time and not counted                                          | dispatches.read           |
| deliveries_in_transit                | Dispatches awaiting a count, not yet due                                                       | dispatches.read           |
| late_counts_to_review                | Late counts waiting for review                                                                 | dispatches.read           |
| open_discrepancies                   | Open dispatch discrepancies                                                                    | dispatches.read           |
| dispatches_draft                     | Dispatches drafted but not sent                                                                | dispatches.dispatch       |
| shifts_to_review                     | Closed shifts not yet reviewed                                                                 | shifts.read               |
| shifts_open_past_day                 | Shifts still open from an earlier business day                                                 | shifts.read               |
| cash_shortages                       | Closed shifts short of cash in the last 7 business days                                        | shifts.read               |
| stock_below_zero                     | Branch stock rows below zero                                                                   | inventory.read            |
| commissary_stock_below_zero          | Commissary stock rows below zero; zero with null details when filtered to a branch             | inventory.commissary_read |
| branch_stock_low                     | Branch items at or below their reorder level, counting stock on the way (see stock-levels.md)  | inventory.read            |
| commissary_stock_low                 | Commissary items at or below their reorder level; 0 when the dashboard is filtered to a branch | inventory.commissary_read |
| reports_to_review / reports_returned | Daily reports submitted / returned                                                             | daily_reports.read        |
| reports_missing                      | Branches that sold yesterday without a report                                                  | daily_reports.read        |
| register_not_opened                  | A scheduled shift started 15+ minutes ago and the branch register is still closed              | schedules.read            |
| register_opened_unscheduled          | Registers opened today by someone not on the schedule                                          | schedules.read            |

Receiving states reuse the Dispatches page rule (`receivingStatus`), so counts match its Overdue, Awaiting count and Review views. The older `/dashboard/overview` and `/branches/:id/dashboard` endpoints are unchanged.

## Dashboard navigation and refresh

Branch readers see their register/report board first. Global readers see sales and alerts first, followed by the full-width branch board; top products is secondary. Each branch has one permission-aware action menu for today's/yesterday's report, current shift or shift list, deliveries, and sales report. Missing-report links open the branch/date-filtered report directory, where authorized users can create a report. Existing-report links open that report directly.

Alerts retain the full category link and add an oldest-record link (or an item search for stock). Stock links show the matching item across balances, since Inventory does not currently offer a below-zero-only filter. Sales-report links preserve the dashboard branch. Failed background refreshes retain the previous data and timestamp, with a visible retry notice. A branch change loads that branch independently; previous-branch figures are never relabeled as the new scope.

No schema migration or inventory/report mutation is involved. Deploy the API before the app because the app validates the added progress/capability fields. Focused integration coverage uses disposable databases, including missing versus empty reports, saved count membership, branch isolation, permission revocation, cash totals, commissary deficits and report prioritization.

## Exception trends

`GET /dashboard/exceptions?branch_id=` (`dashboard.read`, same branch scope and 403 rules as `/dashboard/today`) returns the last 28 completed business days, today excluded, as four 7-day weeks (`week_starts`, oldest first). The app loads it separately and refreshes it every 5 minutes.

- `branches[]`: each scoped branch with `weeks[4]` of `shortage_lines` (negative-variance report items on SUBMITTED/APPROVED reports), `uncosted_shortage_lines`, `shortage_value` (saved report cost, else current average cost; uncosted lines contribute nothing), `cash_short_shifts` and `cash_short_amount` (CLOSED/REVIEWED shifts with a negative cash difference, by shift business date), `receiving_differences` (dispatch discrepancies by reported business date) and `void_count`/`void_amount` (voided sales by sale business date). Inactive branches appear only when they have exceptions.
- Field visibility: shortage counts need `daily_reports.read`, shortage values also `costs.read`, cash fields `shifts.read`, receiving `dispatches.read`; hidden fields are null and `access` says which are shown. Voids follow `dashboard.read`, like today's void count.
- `cashiers`: null without `shifts.read`. Otherwise up to 25 people ordered by short shifts, short amount, then voids, with `total`. Cash figures belong to the shift opener; sales and voids belong to the selling cashier. Each row lists the branches where the person worked.

The app marks a metric "Up" when last week is above zero and above the average of the three earlier weeks, and marks a cashier "Frequent" at 3 or more short shifts making up at least 30% of their shifts. These are prompts to review shifts and counts, not findings of misconduct.
