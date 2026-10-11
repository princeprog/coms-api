# Configurable payment methods

Migration `20261012044805_payment_methods` adds global `payment_methods` (name, kind CASH/NON_CASH, is_active, timestamps) and nullable `sales.payment_method_id`. Cash is the only seeded method. Existing sales and tender snapshots are unchanged. Rollback refuses to discard configured methods or linked sales.

- `GET /payment-methods`: Super Admin, paginated alphabetical directory with search/is_active filters.
- `POST /payment-methods`: Super Admin, `{name, kind, is_active}`.
- `PATCH /payment-methods/:id`: Super Admin, complete edited `{name, kind, is_active}`.
- `POST /payment-methods/:id/deactivate`: Super Admin, soft disable.
- `GET /payment-methods/available`: sales.create permission, enabled ID/name/kind choices.

All routes use current-account access guards. Custom roles are not expanded. Reactivate through PATCH. Case-insensitive duplicate names return 409.

New POS requests include `payment_method_id` and the existing `tender_method`. When ID is supplied, the server ignores the supplied name and snapshots the configured name. Legacy no-ID requests resolve an enabled name case-insensitively. Unknown/disabled choices return 409 `PAYMENT_METHOD_UNAVAILABLE` before any sale writes. The sale transaction holds FOR SHARE on the method; updates serialize with recording. Existing successful retries are resolved before configuration checks, comparing method ID when supplied and preserving original snapshots. No payment processing, stored cash amounts or inventory changes are added.

Local verification: 21 disposable integration tests passed (including payment authorization/CRUD/retries and migration upgrade/guarded rollback), 121 default API tests passed with 44 opt-in DB cases skipped, TypeScript/build/standard Oxlint/format checks passed. The type-aware lint runner failed to launch its Windows tsgolint executable with spawnSync UNKNOWN; no source diagnostics were produced. No browser checks were run. See app docs/payment-methods.md for rollout and frontend evidence. Production deployment has not been performed.
