# CSV exports

Most list pages offer **Export CSV**. The file contains every row that matches the page's current filters, up to 50,000 rows, and uses the same read permission and branch access as the list.

## Exports

| Page | Endpoint | One row per |
| --- | --- | --- |
| Sales history | `GET /branches/:branchId/sales/export` | sale |
| Costs › Profit | `GET /costs/branches/export`, `GET /costs/branch-products/export` | branch (plus total), product |
| Costs › Product costs | `GET /costs/products/export` | product |
| Costs › Stock costs | `GET /costs/stock-items/export` | stock item |
| Inventory | `GET /inventory/commissary/export`, `GET /inventory/branches/:branchId/export` | stock item balance |
| Inventory movements | `GET /inventory/commissary/movements/export`, `GET /inventory/branches/:branchId/movements/export` | movement |
| Supplier receiving | `GET /supplier-receipts/export` | delivery line |
| Direct purchases | `GET /direct-purchases/export` | purchase line |
| Daily reports | `GET /branches/:branchId/daily-reports/export` | report stock line |

Each endpoint accepts the same filters as its list; `page` and `page_size` are ignored.

## File format

UTF-8 with a byte-order mark and CRLF line endings so Excel opens it directly. Times are Manila local `YYYY-MM-DD HH:mm`; money and quantities are plain decimals. Text beginning with `= + - @` is prefixed with `'` so spreadsheets do not run it as a formula. Files are named like `coms-sales-<branch-code>-<from>_<to>.csv`.

## Limits and audit

An export above 50,000 rows returns 400 `EXPORT_TOO_LARGE` with the row count; narrow the filters and try again. Each download records an `export.downloaded` audit event with the file name, row count and filters.

The app downloads through `/api/exports/[kind]`, which allows only known export kinds and their filters and forwards the session cookie and gateway header.

