# Direct purchases

Commissary staff can restock groceries or other directly bought stock without registering a supplier. Branch stock continues to arrive through dispatch receiving.

## API

- `POST /direct-purchases` requires `supplier_receipts.create` and a UUID `Idempotency-Key` header.
- `GET /direct-purchases` and `GET /direct-purchases/:id` require `supplier_receipts.read`.
- Stock selection uses the existing active stock endpoint and `stock_items.read`; `suppliers.read` is unnecessary.
- Input: required `purchase_date` (YYYY-MM-DD, on or before today in Asia/Manila), optional `store_name` (160), `receipt_number` (100), `notes` (1000), and 1–100 distinct active stock lines with `stock_item_id`, positive `quantity_received`, and explicit nonnegative `unit_cost`. Quantities use the stock item's unit; costs use PHP. No branch destination is accepted.
- List query: `search` (store/receipt), inclusive `purchased_from`/`purchased_to`, `sort=newest|oldest`, `page`, `page_size=10|30|50` (default 10). Dates and ordering are applied before pagination.

## Storage and posting

Migration `20261020221155_direct_purchase_receipts` extends existing receipt storage. Existing rows default to `SUPPLIER_DELIVERY`; those require a supplier. `DIRECT_PURCHASE` requires a null supplier. A database check enforces the distinction.

The shared receipt posting repository locks active stock and balances in a stable order, then creates the header, lines, any missing commissary balances, stock increases and source-linked `RECEIPT` movements in one transaction. Repeated matching requests return the same purchase; changed payloads/actor/source with the same key conflict. The existing unique key and movement source constraints prevent duplicate posting.

Purchase date aliases the existing date-only `received_at`. It does not backdate inventory posting. Recorded/created/updated instants remain `timestamptz`. PostgreSQL numeric values and API decimal strings retain precision; never calculate accounting values with floating-point arithmetic.

Supplier receipt list/detail routes explicitly restrict their source kind. Inventory movement responses add receipt ID/kind only, with no costs or purchase metadata. Purchases are final and immutable. Correct quantities with existing reasoned inventory adjustments; financial corrections and returns are outside this release.

## Release and rollback

1. Back up the target, restore to an isolated database, and verify the forward migration before rollout.
2. Apply the migration before deploying the API, then the frontend. Regenerate Kysely types from the migrated schema.
3. Roll back code independently while retaining this additive schema. `down` deliberately refuses if a direct purchase exists, preserving audit history. Never delete purchases just to permit rollback.

Local backup restoration preserved all 58 tables across migration; empty-purchase rollback/reapply was verified. Local deployment preserved all 49 business tables; live authentication token/rate-limit housekeeping changed independently. Production has not been migrated.

## Verification

API build and lint, 191 unit tests, and 40 disposable-database integration tests (direct purchases, supplier receipts and dispatches) passed. Direct-purchase cases cover concurrent identical retries, concurrent separate purchases, invalid/future dates, missing costs, inactive/duplicate items, branch rejection, permissions, backend pagination, source separation, late posting failure rollback and rollback protection. Integration tests must run with `node scripts/test-disposable-db.cjs test/direct-purchases.e2e-spec.ts test/supplier-receipts.e2e-spec.ts test/dispatches.e2e-spec.ts --no-file-parallelism`.
