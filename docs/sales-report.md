# Sales report

An owner-facing summary of one day, week (Monday–Sunday) or month, with a PDF and CSV download. The app page is **Sales report** under Overview (`/sales-report`). The business is not VAT-registered, so amounts are what customers paid; the report has no VAT, discount or expense lines and shows gross profit, not net profit.

## Numbers

Sales belong to the business day of `created_at` (`coms_business_day_start/end`), like Costs & profit.

| Number | Meaning |
| --- | --- |
| Gross sales | Every sale in the period, completed and voided |
| Voided sales | Count and amount of sales now voided |
| Net sales | Completed sales total |
| Sales, average sale, items sold | Completed sales count, net ÷ count, quantity sold |
| Food cost, gross profit, food cost %, cost coverage | Same as Costs & profit, from the cost saved on each sale |
| Waste and count variance value | Approved daily reports in the period |
| Cash over/short | `cash_difference` of closed shifts by business date |

Breakdowns: branches, payment methods (grouped ignoring capitalization), Dine-in/Takeout, categories (current product category), top 10 products by net sales, and day by day for weeks and months.

## Periods and comparison

A period still in progress ends today and is compared with the same number of days at the start of the previous period ("vs same point last week"); finished periods compare with the whole previous period. Change is a percentage, except food cost % which changes in percentage points. A change is empty when the previous period had nothing.

## Access

Permission `sales_report.read` (migration `20261021232101_sales_report_permission`), granted to no role by default. Super Admin sees every branch; others see their assigned branches and get 403 for another branch. Profit, food cost, waste and variance values are `null` (and left out of downloads) unless the user is Super Admin or has `costs.read`.

## API

- `GET /reports/sales?period=day|week|month&date=YYYY-MM-DD&branch_id=` — JSON report. Defaults: this week, all allowed branches. A future date returns 400.
- `GET /reports/sales/export` — CSV with columns Section, Item, Metric, Value, Previous period, Change.
- `GET /reports/sales/pdf` — A4 PDF rendered with `pdfkit` using Noto Sans (`src/assets/fonts`, OFL) for the ₱ sign and the logo in `src/assets`; nest-cli copies `assets` to `dist`.

Both downloads are named `coms-sales-report-<branch-code|all-branches>-<from>_<to>` and record an `export.downloaded` audit event ("Sales report" or "Sales report (PDF)").

