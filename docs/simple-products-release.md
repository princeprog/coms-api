# Simple Products and Branch Menus release

Implemented solo on 2026-10-10 across coms-api and coms-app. The approved simplification replaces branch pricing, requests, templates, recipes and stock usage in active workflows. Pending Dispatch Details, Inventory and ports 3005/3006 are preserved. Production release and commit/push are not part of this delivery.

## Final behavior

- Protected active system `SUPER_ADMIN` alone manages products, the global price and branch menu availability/services. Direct API calls are checked independently of legacy or custom-role grants.
- One product save accepts name, required exact decimal `price`, optional description, `service_types` and selected `branch_ids`. Product creation starts with an empty branch selection. Setup saves are atomic, actor-bound and idempotent; updates check `expected_product_revision`.
- `products.price` and positive `price_revision` are authoritative for catalog, menus and new POS sales. All offering-price mirrors update transactionally. Selecting a branch adds/enables its offering; deselecting disables it without deletion.
- Reads retain permissions and authorized branch scope. Effective services intersect product, offering and branch capabilities. Only Super Admin receives management actions in the app.
- Branch pricing, request, template and recipe endpoints are retired. Historical tables, records, columns and role grants remain. Retired capabilities and product/menu writes are hidden from the editable role catalog and filtered out of live custom-role access.
- New sales require a service and expected global price revisions, retain immutable financial snapshots and record `inventory_deducted=false`. They do not read recipes, check or debit stock, write consumption snapshots, or create stock movements. Client prices/totals are rejected.
- New-sale voids leave inventory unchanged. Historical sales have `inventory_deducted=true`; their voids validate complete saved consumption/movement links, branch, stock item and exact negative quantities before atomic reversal. Missing or inconsistent history rejects the whole void.
- Retry fingerprints include service and price revisions. Successful identical retries return the original sale after subsequent configuration changes. Uncommitted stale prices return typed `PRICE_CHANGED`; the cashier preserves quantities and explicitly reviews/accepts prices before resubmitting.

## Migration and preservation

Forward migration `20261010215853_simple_products_global_price` is migration 24. It locks relevant records, requires exactly one consistent existing price across legacy branch assignments and offerings for every product, and refuses missing or conflicting prices before changing the schema. No price is inferred. On this development target all existing prices were consistent, so no corrective values were supplied.

The migration adds required exact product prices/revisions and backfills existing sales with `inventory_deducted=true`; the default for subsequent inserts is false. It preserves old availability, services, stock balances, sale snapshots and retired records. Rollback is guarded against financial-only sales and changed global price/revision values; prefer a forward correction after use.

Verified local target: loopback PostgreSQL `coms-db`. A database archive was restored into a disposable clone before applying the migration. Exact sorted records in 23 business/access tables matched before and after the local migration, ignoring only added product/sale columns. The backup remains outside the repositories and Obsidian vault. Local migration state: **24 applied, none pending**. Kysely declarations were regenerated for 51 tables.

## Verification

| Check                                                      | Result                                                    |
| ---------------------------------------------------------- | --------------------------------------------------------- |
| Complete API unit/database suite                           | 34 files / 157 tests passed                               |
| Complete API integration suite                             | 13 files / 127 tests passed                               |
| Complete frontend suite                                    | 118 files / 525 tests passed                              |
| API/app lint, TypeScript, formatting and production builds | Passed; final delivery logs are in ignored test artifacts |
| Changed-file whitespace checks                             | Passed                                                    |

API commands: `node scripts/test-disposable-db.cjs --unit --no-file-parallelism`, then the same runner without `--unit` using the verified historical upgrade archives, `pnpm lint`, `pnpm exec tsc --noEmit`, `pnpm build` and changed-TypeScript Prettier checks. Frontend commands: `pnpm test --maxWorkers=2`, full ESLint, `pnpm typecheck`, `pnpm build` and changed-TypeScript Prettier checks. Frontend ESLint uses the existing temporary Windows `node --jitless --max-old-space-size=1024` workaround; no runtime or security setting is persisted.

Coverage includes required prices on both creation paths, forged prices, identical branch prices, atomic branch enable/disable, Super Admin and non-admin/custom-role access, scoped reads, retired endpoints/contracts, stale saves, successful retries, concurrent prices, financial-only sales/voids, strict historical reversals and corrupt/missing deduction history, guarded fresh/upgrade migrations and preserved business records. Review fixes were observed failing before becoming green: partial updates preserving branch selections, financial void copy, compact currency formatting, unavailable-session draft errors and historical void integrity.

Authenticated browser checks used the real production frontend/API and an isolated disposable PostgreSQL database with synthetic Super Admin, Branch Manager and Cashier accounts. Checked required-price validation, initially unselected branches, keyboard branch selection, outage draft retention/unsaved navigation, shared price changes, branch disabling/re-enabling, read-only fixed-branch manager context, Dine-in and Takeout checkout, explicit price review, new-sale void, removed workflows and responsive light/dark layouts.

Browser evidence: a Dine-in sale at 116.004 was voided; a Takeout sale after reviewing 58.002 → 60.003 completed at 240.007 with the original cart quantities. Both have `inventory_deducted=false`. Six branch balances stayed at 100, with zero consumption records and zero inventory movements, even for a product retaining a historical recipe. The old sale's price snapshot remained 58.002. Captures are under `coms-app/test-results/simple-products`.

No automated cases were skipped. Native browser zoom/text scaling, a real screen-reader session, exhaustive browser error combinations and independent reviewer delegation were not performed. Review was a separate author pass under the user's explicit solo instruction. Existing successful-run Vite/Observe and fixture telemetry warnings are recorded in test logs. Production migration/deployment is not performed.

## Coordinated release

1. Verify the intended target, pause writes, and make a fresh restorable backup. Inspect migration state before applying pending files.
2. Run the price preflight. If any product has missing/conflicting prices, stop and obtain an explicit selling price for each affected product. Normalize its legacy assignment/offering prices with a reviewed migration preparation script and repeat the preflight; preserve historical sale snapshots. Never pick a price automatically.
3. Apply forward migrations and regenerate Kysely types. Verify availability, balances and historical records against the backup.
4. Release the API, then frontend, on the configured ports/environment. Refresh all open POS clients so new submissions include service and global price revisions.
5. Check a product save, branch menu and POS sale in the release verification environment. Preserve the archive for recovery; use forward corrections when rollback guards refuse.

The operator guide is `coms-app/docs/simple-products.md`. Obsidian workflow, permissions, schema, decisions and progress notes describe this as the current behavior; earlier entries are retained as historical milestones. A replacement inventory-consumption design remains deferred.

## Create product design and Takeout vocabulary — 2026-10-11

The approved Create product image is implemented with three sections, large service choices, searchable branch rows and a protected footer. Branch lookup uses the existing paginated GET /branches endpoint with an optional trimmed, bounded search. Both records and totals apply escaped literal name search and existing branch scope before pagination, with stable name/ID ordering. The browser action for product availability remains restricted to protected Super Admin.

Takeout is the visible service wording throughout the app, API business errors and operator/workflow documentation. `TAKEAWAY` and `has_takeaway` remain compatible protocol/storage identifiers; no schema migration is introduced and historical sales/retries are preserved.

Verification: frontend **120 files / 530 tests**; complete API unit/database **34 files / 158 tests**; relevant API e2e **3 files / 52 tests**. Both lint/type/production-build checks, changed-source formatting and whitespace pass. Real production browser fixtures verify shared-price product creation, branch selection/search, draft-protected Cancel, read-only scoped product details, Takeout POS and desktop/phone/tablet in both themes. Source/implementation comparison and verification limits are in `coms-app/design-qa.md`; captures are in `coms-app/test-results/create-product-design`. No cases skipped in executed suites; unrelated API e2e suites, native zoom/text scaling and a real screen reader were not repeated. Both fixture databases are disposable and ports 3005/3006 remain intact. No production deployment or commit/push.
