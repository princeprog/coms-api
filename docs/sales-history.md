# Sales history

Sales history uses the existing branch-scoped sales read permission and endpoint. The UI defaults to Today in Asia/Manila, shows 10 rows, and supports 10/30/50 rows. Date, saved payment name, status and cashier/reference search apply on the server before pagination. History parameters use a separate `history_` URL namespace so checkout search, category, service and cart remain independent.

`GET /branches/:branchId/sales` accepts `date_from`, `date_to` (inclusive Manila calendar dates), `status`, `tender_method`, `search`, `page` and `page_size`. Invalid dates/ranges return 400. Exact `S-000123` searches use the unique sale-number index; other searches match cashier names. Payment options come from the branch's saved tender snapshots, including renamed, inactive and legacy methods.

The response adds `summary` (`net_sales` as an exact decimal string, `completed_sales`, `voided_sales`) for all matching rows, not just the current page. Every active filter applies to the summary. Net sales excludes VOIDED sales; a voided-only filter therefore has zero net sales. List rows and aggregates use one repeatable-read transaction. This is a current-status transaction log by sale creation date, not a replacement for frozen daily-report accounting.

Migration `20261020185858_sale_references` adds a unique sequence-backed bigint sale number and backfills existing rows in creation order. List, details, create and retry responses expose the same `sale_reference`, prefixed `S-` and padded to at least six digits. References are unique but not gapless and are not fiscal receipt numbers. Existing UUIDs, financial snapshots and void/retry behavior are unchanged. Rollback removes references; do not roll back after references have been distributed to operators.

Deploy the migration and API before the frontend. Development localhost:5432/coms-db is migrated to 28; production deployment is not performed. Frontend gracefully omits the new summary/reference when connected to an older response, but new query parameters require the updated API.

Verification: 14 sales integration cases on a disposable PostgreSQL database, including branch permissions, exact summaries, Manila date boundaries, combined filters, all page sizes and populated migration rollback/backfill; frontend sales/fixture checks and synthetic production-browser flows cover filtering, pagination, reason-required voiding, refresh, custom-date validation, responsiveness and cart preservation. No live sale was created or voided during browser checks.
