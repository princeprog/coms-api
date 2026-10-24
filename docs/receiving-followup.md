# Dispatch receiving follow-up

## Behavior

Senders choose `receive_by` when sending a new or saved draft dispatch. It must be in the future; omitted values default to 24 hours after sending. The deadline is immutable after dispatch. Existing uncounted dispatched records receive 24 hours of grace from migration time. Dates and scheduled reminders use Asia/Manila.

The receiving task is independent of dispatch lifecycle and personal notification read state. List/detail responses expose `receiving_status`: `NONE`, `AWAITING_COUNT`, `OVERDUE`, `REVIEW`, or `COUNTED`. `GET /dispatches?receiving_status=pending` returns outstanding tasks; the three active statuses can be filtered individually. Existing branch authorization, search and server pagination remain authoritative. The system never automatically receives or zero-counts stock.

## Count and report contracts

- Send requests accept optional ISO `receive_by`. Matching retries retain the saved deadline; conflicting explicit deadlines reject reuse.
- Receive requests accept optional `delivery_date` (YYYY-MM-DD, dispatch date through today) and `late_reason` (required for past-day or overdue counts, maximum 500 characters). The branch UI omits `delivery_date`: the API records the confirmation date in Asia/Manila automatically, separately from the dispatch timestamp. The saved receiving date drives report receipt totals; audit timestamps retain actual submission/posting time. Explicit dates remain supported for legacy clients and posting saved historical review cases; existing history is unchanged.
- Matching retries of posted receipts and held counts retain their original date and timestamp, including after midnight or the deadline. Validate held-count retry payloads before applying current deadline rules; changed items, actor, note, reason or an explicitly conflicting date still reject key reuse. Returned counts still require a new key.
- Normal counts return `receiving_outcome: POSTED`. A count affecting submitted or approved reports on or after its delivery date returns `REVIEW_REQUIRED`, saves an immutable count case and notifies eligible reviewers without changing inventory.
- `POST /dispatches/:id/late-counts/:caseId/review` accepts `{action: POST}` or `{action: RETURN, reason}`. It requires existing `dispatches.shortage_close` and branch access. A counter cannot review their own case. Posting consumes the saved quantities and original counter, records reviewer/time, and writes inventory once. Returning requires a reason and retains the original case in history; a corrected submission uses a new retry key.
- Submitted affected reports must be returned before posting. Approved affected reports keep the count on hold. Historical approved-report correction is intentionally outside this release; never force-post or silently rewrite an approved report.
- Daily-report submission accepts `delivery_exceptions: [{dispatch_id, reason}]`. Every uncounted delivery sent by that business day's end needs either a count or an explicit not-arrived reason. A saved arrived count awaiting review cannot be bypassed with this exception. Submission events retain immutable reason snapshots. Stale exceptions for a delivery counted while the form was open are ignored.
- Report approval blocks pending arrived count cases affecting its business date. Report and receiving transactions serialize per branch using the same advisory lock, preventing approval/count races. Backdated approval preserves later stock movements and does not count the receipt twice.

## Reminders and authorization

The API performs a sweep on startup and once per minute, with one sweep in flight per process. It creates at most one overdue summary per branch per Manila day. A branch's first reminder is immediate; subsequent daily reminders are eligible from 09:00 PHT. Each summary contains the current overdue count and links to the branch's overdue tasks. Multiple workers are safe through a per-branch transaction lock and unique daily source. A bounded batch of 100 branches prevents unbounded individual sweeps.

Recipients are active, branch-assigned accounts with dispatch read access and receiving or shortage-resolution capability. Late-count review alerts require shortage-resolution capability. Protected Super Admin is excluded from these new routine notifications. Existing Super Admin review permissions remain unchanged. No email, push, sound, or external messages are sent. Personal read state never clears a receiving task.

## Release and rollback

Apply `20261020202353_dispatch_receiving_followup`, regenerate Kysely types, release API, then app. The additive migration has been applied only to verified local development `localhost:5432/coms-db`: 30 applied migrations, none pending. Other environments still require migration before release.

Prefer reverting application code while retaining the additive schema. Migration down removes follow-up cases, exception history and notification sources; it is a destructive rollback for feature history and is tested only in a disposable database. Existing dispatch/inventory records remain intact. Do not run down against operational data as a routine code rollback.

## Verification

- Automatic receiving-date update (2026-10-24): all 9 receiving follow-up integration cases passed in a disposable database with 44 migrations, including next-day posted-receipt retries and held-count retries after midnight/deadline changes. Changed-file lint and the production build passed. No operational data or schema migration is needed for this update. Run with `--exclude '.tmp/**' --no-file-parallelism` to exclude ignored baseline archives.
- API unit run: 175 passed, 44 opt-in database cases skipped.
- New disposable PostgreSQL integration suite: 7 passed, covering deadline validation/retries, reminder deduplication and recipients, report exceptions, saved late counts, independent review, approved holds, approval/count concurrency, actual-date report totals, inventory preservation, and migration down/up.
- Existing dispatch/daily-report/notification regression suites: 38 passed using `--maxWorkers=1`. Parallel suites share a disposable database and can interfere with global count assertions and migration roundtrips; run these serially. The new follow-up suite runs in its own disposable database.
- API lint, TypeScript and production build checked. Integration databases are disposed after each run. Browser evidence is recorded in the app documentation; its synthetic data does not establish database correctness.

Author review is performed locally without subagents. Commit API before app; no push or deployment is part of this task.
