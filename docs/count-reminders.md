# Manual delivery count reminders

Authorized senders can remind a branch to submit its delivery count from the dispatch row menu or the detail page's Receiving section. Reminders use the existing in-app inbox and bell. They do not record receipt, adjust inventory, resolve discrepancies, or change receiving status.

## API and policy

`POST /dispatches/:id/count-reminders` requires a UUID `Idempotency-Key`, `dispatches.read` and `dispatches.dispatch`, and access to the destination branch. The existing active Super Admin bypass applies. The destination must be active and the delivery must be `AWAITING_COUNT` or `OVERDUE`.

Recipients are active users with an active role, an active destination assignment, and both dispatch read and receive permissions. The sender, original dispatcher, Super Admins, and unrelated branches are excluded. Zero eligible recipients produces a 409 and rolls back the entire reminder.

One reminder is allowed per dispatch every 30 minutes across all senders. A 429 response includes `next_allowed_at` and `retry_after_seconds`. The receiving branch lock and dispatch row lock serialize reminder requests with count submission. Matching retries return the existing result without another notification, including after counting; reused keys for other actors/actions are rejected.

The transaction records `COUNT_REMINDER_SENT` in dispatch activity, then a `DISPATCH_COUNT_REMINDER` notification and its recipients. Notification copy is “Delivery count pending” / “Please count this delivery and submit the quantities received.” The existing dispatch link opens the count workflow without revealing sent quantities in the notification.

List/detail responses include `count_reminder: { last_sent_at, next_allowed_at }` with UTC ISO timestamps, or null for an inactive branch. Both timestamps are null before the first reminder. The partial dispatch-event index supports these lookups. UI timestamps use PHT; reading a notification is independent of receiving status.

## Rollout and rollback

Migration `20261024230410_manual_dispatch_count_reminders` extends existing constraints and adds an index, with no new tables or columns. Generated Kysely types remain unchanged. Deploy the compatible frontend before enabling the new API event kind: apply the migration, deploy the frontend, then deploy the API. The frontend hides the action when metadata is absent, so it works with the old API.

For a code rollback, retain the additive schema while reminder history exists and retain frontend support for the new notification/activity kinds. Migration `down` deliberately rejects rollback when reminder events exist; it does not delete historical records.

## Verification

- Disposable PostgreSQL: `node scripts/test-disposable-db.cjs test/count-reminders.e2e-spec.ts --no-file-parallelism` (10 cases). Set `COMS_TEST_ADMIN_URL` to an isolated local test server first.
- Existing notification integration suite (12 cases), API unit suite, build, and scoped lint.
- Frontend dispatch/notification tests, types, lint, production build, and `node test/count-reminder-browser.cjs` (loopback fixtures, keyboard, retry, cooldown, history, inbox navigation, row action, light/dark/mobile).

Verification on 2026-10-24 used a disposable local PostgreSQL cluster. No production migration or deployment was performed.
