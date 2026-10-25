# Offline POS and PWA implementation

Approved scope: Windows Chrome/Edge and Android Chrome; manager-approved branch devices; cash only while offline; continue a shift opened online; honor immutable downloaded prices and recipes. Closing (including forced closing) and report finalization require every offline session to be finalized with all sequences acknowledged. No lost-device zero-sale override.

## Status

Implemented in both repositories: additive schema (migration `20261026004254_pos_offline_sessions`), immutable menu/recipe/cost snapshots, ordered idempotent ingestion with held-sale review, device approval, shift close and daily report guards, occurrence-time reporting, the production Workbox PWA with a public offline shell, IndexedDB register storage with single-writer locks, recovery export/import and foreground sync, the cashier register and the manager page at Branches → Offline registers.

## Enabling for a pilot branch

1. Set `COMS_OFFLINE_POS_ENABLED=true` in the API environment and restart. Turning it off later blocks new preparation only; prepared registers keep syncing and finalizing.
2. Deploy the frontend production build over HTTPS. `pnpm build` also generates `public/sw.js` and the offline shell; both must ship with the build.
3. Grant the Branch Manager role `pos_offline.devices_manage` and `pos_offline.review` (seeded for the predefined role).
4. On the register: open COMS in Chrome or Edge, install it, sign in as the cashier, open the shift, select Register this browser, and have a manager approve it from Branches → Offline registers.
5. Each shift: Prepare offline POS after the shift is open. Cash sales then save on the device first and sync when online. Finalize the register before closing the shift.

Recovery: if a device cannot sync, the cashier exports the recovery file and a manager imports it on the Offline registers page. Finishing a session for a lost device requires the complete original export; there is no zero-sale override.

## Contracts

Browser calls same-origin `/api/pos-offline/branches/:branchId/...`; Next forwards HttpOnly cookies through the existing private API gateway. Session preparation returns `{session, snapshot}`. Session fields: id, device_id, shift_id, branch_id, cashier_id, issued_at, cutoff_at, server_time, business_date. Snapshot fields: id, products, cash_payment_method, branch. Server snapshot additionally retains recipe and cost inputs; these are never returned to the cashier.

Envelope version 1: id (UUID), session_id, device_id, shift_id, sequence (positive integer), snapshot_id, captured_at (offset instant), service_type, items (product_id, quantity, unit_price, price_revision), cash_tendered, total_amount. Money and quantities are decimal strings. Sync returns `{results:[{id,status,sale_id?,sale_reference?,reason?}]}` with ACKNOWLEDGED or NEEDS_REVIEW. Identical retries return the original acknowledgement; changed payloads never replace a saved transaction.

All prepared cash transactions use the outbox online and offline. Foreground synchronization is authoritative; background sync is optional. Store no credentials in IndexedDB. Preserve pending work on authentication expiry and logout, lock it to its original cashier, and require normal online reauthentication to unlock. App updates must not interrupt an active cart or pending queue. Feature flag defaults off for preparation; existing sessions remain drainable.

## Verification gates

Test duplicate and lost-response retries, original price/recipe/cost, delayed occurrence dates, tampering and revocation, gaps/finalization, forced close/report guards, storage failures, reload persistence, multiple tabs, account scope, safe service-worker caching and updates. Run scoped lint, explicit TypeScript checks and production builds in both repositories. Pilot on one approved branch device before broad rollout. Physical Android installation verification remains an explicit deployment acceptance check if no Android device is available locally.

Real-browser checks run against `test/offline-pos-browser-fixture.cjs` (production builds, real API and authentication, disposable database): `coms-app/features/pwa/production-browser.mjs` for caching and updates, and `coms-app/test/offline-pos-flow-browser.cjs` for the cashier flow. Headless browsers cannot grant persistent storage, so the flow test simulates that grant; installed Chrome and Edge apps normally grant it.
