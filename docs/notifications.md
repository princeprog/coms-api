# In-app notifications

Notification events and recipients are written in the same transaction as the source workflow event. Unique source-event foreign keys and `(event_id, user_id)` prevent duplicate delivery. Retry paths do not notify again; a resubmitted daily report has its own event. Individual variance closures do not notify the receiving team until every variance is settled.

| Event | Eligible recipients |
| --- | --- |
| DISPATCH_SENT | dispatches.read + dispatches.receive |
| DISPATCH_RECEIVED | dispatches.read + dispatches.dispatch (the sending team), when a branch count posts with no differences; not Super Admin |
| DISPATCH_DISCREPANCY | dispatches.read + dispatches.shortage_close; protected Super Admin |
| DISPATCH_RESOLVED | dispatches.read + dispatches.receive |
| REPORT_SUBMITTED | daily_reports.read + approve or return; protected Super Admin |
| REPORT_RETURNED / REPORT_APPROVED | daily_reports.read + update or submit |

Ordinary recipients need an active account/role and an active assignment to the affected branch. The acting user is excluded. Super Admin receives only the two review types, without requiring branch assignment. Other role names have no special meaning. No eligible recipients does not block the operation.

GET `/notifications` accepts `status=all|unread`, `type=all|dispatches|reports`, `page` (default 1), and `page_size=10|30|50` (default 10). Returns `{items,total,page,page_size}` newest first with a stable tie-breaker. Item data contains a recipient ID, kind, branch identity/name, dispatch/report target, report business date, creation time, and read time; it does not expose quantities, reasons or financial totals. GET `/notifications/unread-count` returns `{unread_count}`.

PATCH `/notifications/:id/read` returns `{id,read_at}` and is idempotent. PATCH `/notifications/read-all` returns `{updated:true}` and only updates unread rows visible to its SQL statement snapshot; later arrivals stay unread. Every endpoint enforces personal ownership, current record-read grants, and branch access. Super Admin cannot inspect another user's inbox. Notifications are historical events, not an authoritative task-status queue; linked details show the current workflow state.

## Release and verification

Apply `20261020193411_notifications` before releasing the API, then release the app. The migration is additive, has no historical backfill and grants no new permissions. Its rollback drops only notification tables and therefore discards notification/read history; use it only in a controlled environment. Keep the schema when rolling application code back. No background workers, external delivery or retention jobs are required.

Run `node scripts/test-disposable-db.cjs --no-file-parallelism test/notifications.e2e-spec.ts test/dispatches.e2e-spec.ts test/daily-reports.e2e-spec.ts`. Tests cover recipient scope, actor/inactive exclusion, concurrent retries, final resolution, report resubmission, rollback, ownership/access revocation, paging, concurrent mark-all, and migration reversal/reapplication. Use serial execution because these suites share their disposable database. Ordinary API unit tests skip separately gated database suites.

Local development has 29 applied migrations. No production deployment is implied. This version creates new in-app events only; no sales-completion alerts, email, SMS, push, historical backfill or automatic deletion.
