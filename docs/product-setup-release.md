# Stock usage and product setup release

> Superseded by [Simple Products and Branch Menus](simple-products-release.md). This document preserves verification of the retired workflow.

Implemented 2026-10-10 across both repositories, preserving pending Branch Menu, Dispatch Details, Inventory, and port changes. The user requested solo implementation. No commit, push, or production deployment is included.

## Contracts

- `stock_items.usage_types` contains one or more unique values: `INGREDIENT`, `PACKAGING`, `READY_TO_SELL`, `OPERATING_SUPPLY`. New stock creation requires an explicit selection; list filtering is server-side. Classification removal is rejected when a current component still requires that usage.
- `products.preparation_type` is `PREPARED` or `READY_TO_SELL`; `setup_revision` protects metadata and `recipe_revision` protects consumption. Permitted-service changes advance a nonempty recipe's revision so previously loaded recipe decisions cannot silently approve against old eligibility.
- `product_ingredients.component_type` records Ingredient, Packaging, or Ready to sell. Prepared products require ingredients for each permitted service. Direct-sale products require exactly one Ready to sell component in ALL scope, no ingredients, and optional packaging. Prepared products can include direct-sale accompaniments.
- Quantities retain exact positive decimal strings, the existing 100-component limit, ALL/DINE_IN/TAKEAWAY scopes, and no duplicate stock item within a scope. Component saves and sale transactions require active stock with the matching allowed usage. Voids use historical consumption snapshots.
- `POST /products/setup`, `GET /products/:id/setup`, and `PUT /products/:id/setup` extend the existing feature module. Metadata, consumption, and branch prices save atomically, with independent existing capabilities per section, authorized branch scope, expected revisions, and UUID idempotency. Successful matching retries return the original result after later configuration changes; mismatched key reuse conflicts.
- Central branch prices remain authoritative and synchronize legacy offering prices transactionally. Product setup and approved new products never create offerings automatically. The setup read exposes only authorized branch price assignments.
- `GET /branches/:id/menu-candidates?include_blocked=true` returns eligible and blocked products with specific reasons. The candidate DTO validates the optional boolean flag; invalid values fail validation. Pricing-directory queries retain their own contract.
- Requests retain original component/mode proposals and current target snapshots separately from adjusted decisions. All approval validation and writes remain transactional. Templates and sales reuse the same eligibility rules. No new grants or automatic custom-role expansion.

## Migration and existing data

Forward migration `20261010174904_stock_usage_product_setup` adds classifications, product mode/setup revision, component type, and successful setup-operation records. Existing referenced stock is classified Ingredient; other stock is Operating supply. Existing products remain Prepared and existing recipe lines remain Ingredient. There is no guessing from categories or names, no quantity/price changes, and no rewriting saved sale consumption.

The verified loopback development target `localhost:5432/coms-db` has **23 applied migrations** and regenerated Kysely declarations. A pre-migration backup was restored into an isolated clone and tested before local application. Backup archives and connection metadata stay outside the Obsidian vault. Rollback refuses to discard newly used classifications, modes, component types, or setup-operation records; use a reviewed forward correction after those records exist.

## Coordinated rollout

1. Verify the intended target, migration history, API/frontend versions, and exact role grants. Take a fresh target backup and prove it restores into an isolated verification database. The local development archive is not a production backup.
2. Apply any pending Branch Menu migrations first, then `20261010174904_stock_usage_product_setup`. Inspect backfills and regenerate types against the resulting schema during release preparation.
3. Release API, then frontend together. Refresh open POS clients; service types and expected price revisions remain required. Stock creation now requires explicit usages, and old setup clients cannot classify components.
4. Have central staff review legacy packaging, drinks, and operating supplies in Stock Items. Add the appropriate usages, then deliberately update component types and scopes through product setup. This review is necessary because backfills preserve behavior rather than infer business meaning.
5. Verify Prepared and Ready to sell setup, central price assignment, authorized manager menu addition, adjusted request approval, Dine-in/Takeout sale deductions, and a permitted historical-snapshot void with disposable release records.
6. Monitor setup, price, recipe, and request conflicts. Keep drafts and require review of current values instead of automatically overwriting them. Follow the separately verified backup recovery procedure if forward correction is insufficient.

User workflow: `coms-app/docs/product-setup.md`.

## Verification evidence

Final verification on 2026-10-10 used the current production source and synthetic disposable fixtures:

| Check                                    | Result                                                                 | Evidence                                                                     |
| ---------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Complete API unit/database suite         | 32 files, 154 passed, no skips                                         | `test-results/product-setup-unit-final.log`                                  |
| Complete disposable API e2e suite        | 15 files, 147 passed, no skips                                         | `test-results/product-setup-e2e-final.log`                                   |
| Complete frontend suite                  | 124 files, 564 passed                                                  | `coms-app/test-results/product-setup-full-tests-final.log`                   |
| Final component/layout checks            | 3 files, 13 passed                                                     | `coms-app/test-results/product-setup-final-polish-tests.log`                 |
| TypeScript, full lint, production builds | Both repositories passed; API lint has four existing warnings          | `test-results/product-setup-{types,lint,build}-final.log` in each repository |
| Changed TypeScript formatting            | 200 frontend and 67 API files passed, including generated declarations | `test-results/product-setup-format-final.log` in each repository             |
| Local migration state                    | All 23 applied; none pending                                           | `test-results/product-setup-migrations-final.log`                            |
| Existing data preservation               | All 23 checked tables unchanged after excluding only added columns     | `test-results/product-setup-preservation-final.log`                          |

The API suite includes ten product-setup cases and two restored-backup upgrade cases. It covers classifications and filtering, component/mode validation, exact scoped deductions, historical voids after recipe changes, revision conflicts, actor-bound successful retries, transactional rollback, central capability checks, branch isolation, complete reviewed new-product approval without automatic offering creation, guarded rollback, and preserved legacy values/grants. Service eligibility changes invalidate older recipe decisions. Existing menu/request/template/POS cases also run in the complete suite.

The real browser found a candidate-query whitelist failure: `include_blocked=true` was rejected before reaching the supported repository query. A new API regression was observed failing with HTTP 400, then passed after adding the candidate-specific validated DTO. The browser subsequently displayed eligible products, disabled missing-price products, and already-on-menu reasons. Red/green logs: `test-results/product-setup-candidates-red.log` and `product-setup-candidates-green.log`.

### Real browser and database flows

- Built frontend/API, real sign-in and guards, and disposable PostgreSQL records were used. Central staff created Prepared and Ready to sell products with exact component quantities, service-specific packaging, and central prices in one save. Multiple stock usages and keyboard usage filtering were exercised.
- A manager inspected readable setup without central editing controls, submitted a recipe proposal, and a central reviewer adjusted packaging from the proposed 2 to 1.25 before approval. The original proposal, approved result, and decision history stayed separate. The manager added both prepared and direct-sale products through the fixed-branch menu dialog with read-only central prices.
- Cashier checkout required service selection before adding items. A Takeout sale of two direct drinks and one prepared meal saved **245.002**; a Dine-in sale of one drink and one meal saved **190.001**. Read-only SQL assertions confirmed Takeout deductions of 2 bottles, 0.1 kg chicken, and 3 boxes, and Dine-in deductions of 1 bottle and 0.1 kg chicken with no box. Final balances were 97 bottles, 99.8 kg chicken, and 97 boxes. Evidence: `test-results/product-setup-browser-proof.log`.
- Desktop, 390px phone in both themes, and 768px tablet were inspected. Compact component rows keep visible labels, stock units, keyboard-operable selectors, and exact deduction previews. No document overflow was observed, and final browser warning/error logs were empty.
- Captures are in `coms-app/test-results/product-setup/`: `prepared-setup-desktop.png`, `product-setup-desktop.png`, `stock-usage-desktop.png`, `components-mobile-light.png`, `components-mobile-dark.png`, `product-setup-tablet-dark.png`, `approved-request.png`, `manager-menu-added.png`, and `service-sales-history.png`.

The preservation comparison covers 18 operational/catalog tables plus users, roles, permissions, role grants, and branch assignments against the verified pre-migration restored clone. It logs only table names/counts and equality, never authentication values. The restored clone and disposable browser database/processes were removed; the verified archive remains outside the vault. Test artifacts are ignored by Git. The user browser returns to COMS at `http://localhost:3005`; the local API remains on 3006.

### Warnings and limits

Four existing `no-misused-spread` API warnings remain in request/template DTO projections. Existing Vite configuration, Observe worker, and fixture telemetry warnings appear in successful runs. Frontend ESLint used the temporary `node --jitless --max-old-space-size=1024` workaround for the previously observed Windows Node allocation issue; no runtime or security setting was persisted.

One complete API run encountered an intermittent HTTP 409 in the existing dispatch concurrent-successful-retry test. Both focused concurrent-dispatch cases passed, then the complete 147-case suite passed. The cause of that intermittent failure remains unresolved; no dispatch implementation, assertion, or timeout was changed. Focused evidence: `test-results/product-setup-dispatch-retry-check.log`.

No real screen-reader session, native zoom/text-scaling session, exhaustive browser error matrix, or independent agent review was performed. Keyboard, semantic names, responsive themes, draft/retry/conflict component coverage, and database boundary cases were verified. Review was solo as requested. Production rollout, commit, and push remain outside this task.
