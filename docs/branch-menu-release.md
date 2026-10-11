# Branch Menu release and verification

> Historical workflow, superseded by [Simple Products and Branch Menus](simple-products-release.md). Active branch pricing, recipe, request and template workflows described below are retired; their records remain historical.

Implemented 2026-10-08 across `coms-api` and `coms-app`. Existing Dispatch Details and Inventory edits remain in place. No production deployment, commit, or push was performed.

## Ownership and access

- Central staff maintain shared products, service eligibility, recipes and exact branch price assignments. `branch_products.update` controls central pricing.
- Branch Managers add centrally priced eligible products, narrow menu service choices, change availability, submit requests and apply templates only at authorized branches.
- The eight new permission keys cover offering services, request read/create/cancel/review and template read/manage/apply. Active predefined roles receive the reviewed additions once; unrelated grants, administrator edits, custom roles and user assignments remain intact.
- Review also requires the underlying product, recipe or price capability. Reviewers cannot approve their own requests. Only the submitting user can cancel a pending request.

## Data and transaction contracts

- `branch_product_prices` is authoritative. Version-checked changes synchronize the compatibility offering price within the transaction. Missing assignments block menu creation and sales; one branch price applies to both services.
- Effective service eligibility intersects product choices, offering choices and branch capabilities. Existing records default to both services; existing branches default to takeout enabled. Active branches require at least one capability.
- Recipes use exact positive decimal-string quantities and `ALL`, `DINE_IN`, or `TAKEAWAY` scopes. A stock item can appear once in each scope. Sale consumption sums shared and selected-service quantities.
- Recipe replacements, price assignments, request decisions and template applications check revisions. Request submission and decisions use idempotency keys. Original proposals and target snapshots remain separate from approved details and resulting records.
- Approval applies the reviewed mutation and audit decision atomically. New products require a complete valid recipe and assigned requesting-branch price; approval does not add a menu offering.
- Template revisions never automatically modify menus. Preview identifies additions, existing products and blocked reasons. Applying a current preview adds eligible missing products atomically and preserves existing availability, services and prices. Removed members remain for manager review; repeated application is idempotent.
- New sales require `service_type` and each line's expected `price_revision`. The transaction rechecks availability, eligibility, prices, active ingredients and stock. `PRICE_CHANGED` preserves the cart and requires explicit price acceptance before resubmission.
- Successful identical sale retries return their original saved result after configuration changes. Historical sales retain original price and consumption snapshots; unspecified service is displayed as **Not recorded**. Voids reverse saved consumption, including packaging, after later recipe changes.

## Frontend

Navigation reads **Branch Menu** while `/branch-products` remains compatible. New pages provide central Branch Pricing, Menu Requests and Menu Templates. Long request, review and membership workflows use dedicated pages; price requests use a short dialog. Fixed branch context replaces selectors for single-branch users. Search uses 350 ms debounce; applied filters, sorting, pagination and eligibility remain server-driven and URL-backed. Shadcn confirmations state the effect and preserve drafts on errors.

POS requires a service before adding products when both are supported and selects Takeout automatically when it is the only choice. Switching services preserves quantities and blocks incompatible carts. A changed-price review displays old/current prices and requires **Accept updated prices** before recording again.

## Verification evidence

- Complete API unit/database suite: **32 files / 154 tests passed**, with database tests enabled. Complete e2e suite: **13 files / 135 tests passed**, no skipped cases.
- Fresh-database menu workflow coverage: **17 cases**. Restored pre-migration backup upgrade coverage: **3 cases**, including exact legacy price/sale preservation, custom grants, guarded rollback and safe rollback/reapplication.
- API TypeScript, syntax oxlint, full type-aware lint and production build passed. Type-aware lint initially failed to spawn `tsgolint.exe` on Windows (`UNKNOWN`), then succeeded on the final retry without changing security settings. Four non-blocking `no-misused-spread` warnings remain for intentional DTO-to-data projections. Existing Vite/Observe worker warnings appear in successful test logs.
- Complete frontend suite: **119 files / 543 tests passed**. Final ESLint, TypeScript, production build, changed-file Prettier checks and Git whitespace checks passed. Two existing staff-form tests failed during the default parallel run; all seven staff tests passed in isolation, then the whole suite passed with `--maxWorkers=2`, including a second complete delivery run. No assertions or timeouts were relaxed.
- Formatting checks cover **142 frontend files / 53 API files**, excluding generated Kysely declarations. Full logs are retained in ignored `coms-app/test-results/menu-*` and `coms-api/.tmp/menu-*`; final implementation and browser evidence are recorded in the ledger and Obsidian Delivery/Progress.
- Real browser flows use built production frontend/API builds, real authentication and permission guards, and synthetic records in a disposable loopback database. Confirmed fixed manager scope, centrally priced menu creation, service narrowing, all three request types, adjusted price/product/recipe approvals, cancellation, template edit/preview/application/repeat behavior and cashier service/price-review checkout.
- Browser sale snapshots confirm takeout quantity 2 at 128.75 totals 257.5 and consumes 0.2 kg chicken plus 2 boxes; dine-in quantity 1 at 135 consumes 0.1 kg chicken with no box. Shared recipe approval afterward preserves saved sale data.
- Keyboard actions and 390px mobile, 768px tablet and default desktop layouts were checked; key menu, request/template and POS states were inspected in both themes without document overflow. Browser warning/error logs were empty. A real screen-reader session, native zoom/text scaling and an exhaustive browser matrix of every error/state were not run; component and integration tests cover those application states.
- Solo author review was used as requested; no independent subagent review.

## Coordinated rollout

1. Verify the intended deployment database, current migration list and application versions. Take a new backup of that target and prove it restores into an isolated verification database. The local verified development backup is not a production backup.
2. Schedule the coordinated change and prevent old open POS clients from submitting during it. Preserve unfinished orders for operator review.
3. Apply the forward migrations in order: `20261008004901_branch_menu_service_schema`, `20261008004902_branch_menu_permissions`, then `20261010174904_stock_usage_product_setup`. Review exact price and stock-usage backfills; regenerate Kysely types if preparing against a different schema. Follow [product setup release](product-setup-release.md) for classification review and current verification.
4. Release the API build, then the frontend build. New sale bodies require service and price revisions, so refresh all open POS clients before resuming checkout.
5. Verify manager, authorized central reviewer and cashier access; a centrally priced menu addition; a request decision; a template preview; and both services at a suitable branch. Check recorded totals and stock movements using disposable release fixtures.
6. Observe conflicts and errors. A price conflict requires cashier review rather than automatic resubmission. After new service/request/template data exists, guarded rollback may refuse to discard it; prefer a reviewed forward correction or the separately verified recovery procedure.

Local development `coms-db` has **23 applied migrations** and regenerated Kysely types as of 2026-10-10. Production migration and deployment remain pending. The verification counts above describe the 2026-10-08 milestone; current evidence is in [product setup release](product-setup-release.md).

Delivery platforms, service-dependent prices, scheduled prices, independently editable branch recipes and automatic template synchronization remain outside this implementation.
