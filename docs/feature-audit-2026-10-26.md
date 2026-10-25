# COMS feature audit — 2026-10-26

Reviewed API `0862765` and frontend `27286db` on `dev`. This is an audit, not a bug-fix release. No application behavior or business records were changed. Tests used disposable PostgreSQL databases and synthetic loopback browser fixtures.

## Findings requiring implementation work

### P1 — A password change can overwrite a concurrent admin reset

**Location:** `coms-api/src/modules/auth/auth.service.ts:212–227`; `auth.repository.ts:39–64`.

`changePassword` verifies the current password before its transaction. After hashing the replacement, it locks the account and checks only whether it is active. It does not verify that the locked password hash is still the one checked earlier. If an admin resets the password between those operations, the older request overwrites the reset and clears `must_change_password`.

Reproduced with the actual AuthService and actual Argon2 hashing, using a repository stub to deterministically interleave the operations:

1. The initial read returns the original active account and password hash.
2. The locked read returns an admin-reset hash and `must_change_password: true`.
3. Changing the password with the original credential succeeds, overwrites the reset and returns `must_change_password: false`.

This is a service-level concurrency reproduction, not a timed HTTP exploit or a change to a real account. Recheck the credential/version under the lock, reject stale requests, and add a reset-versus-change regression test. A normal sequential reset/onboarding flow already passes.

### P2 — Sales-report downloads can use a stale date after changing filters

**Location:** `coms-app/features/sales-report/components/sales-report-workspace.tsx:45–99`.

The query retains the previous report while the next report loads. Export parameters combine the new period/branch with `report.range.to` from the previous report. Download buttons remain enabled.

Reproduced in the actual component with TanStack Query and a deferred server-action response:

1. Load the week containing October 14; its report ends October 18.
2. Change the query to September 15, monthly, for a branch; keep that response pending.
3. Click Download PDF.
4. The request is `period=month&date=2026-10-18&branch_id=…`, exporting October instead of September.

CSV uses the same parameter object. Disable downloads while data belongs to the previous query, or derive the complete export context from one consistent loaded report. Add a slow-filter-change regression test for both formats.

## Incomplete workflows and product backlog

These are missing capabilities, not failed implementations of existing supported actions.

| Capability                                  | Current boundary                                                                                                                                                                                                                             | Recommended next step                                                                                                               |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Historical correction after report approval | Late receiving counts affecting approved reports are held; there is no supported correction workflow to release them. Explicitly documented in `docs/receiving-followup.md:14–16`. Normal return/approve and reconciliation are implemented. | Define an audited correction workflow preserving approved snapshots and ledger history.                                             |
| Commissary production batches               | Receipts, purchases, dispatches and sale recipe deduction exist; transforming raw ingredients into prepared stock with batch costing remains on the backlog.                                                                                 | Specify inputs, yield, wastage, output stock and cost allocation.                                                                   |
| Discounts/promotions                        | Dedicated discount entry and reporting are not implemented in the active sale flow.                                                                                                                                                          | Decide supported discount types and calculation/reporting rules.                                                                    |
| Receipt/POS-of-record scope                 | Official receipt and tax-related product requirements remain undecided in the backlog.                                                                                                                                                       | Decide COMS's role alongside any separate cash register before specifying this work. This audit does not evaluate legal compliance. |
| Transfers, returns and purchase orders      | Branch-to-branch transfers, supplier/commissary returns and orders preceding deliveries are not active workflows.                                                                                                                            | Prioritize the actual operational need and define ledger effects.                                                                   |
| Offline POS                                 | No offline sale queue/synchronization workflow found.                                                                                                                                                                                        | Define conflict, stock, payment and shift behavior before implementation.                                                           |
| Self-service email recovery                 | Admin reset and CLI recovery exist; emailed reset links do not.                                                                                                                                                                              | Add a provider and expiring single-use recovery flow if required.                                                                   |
| Production operations                       | Production deployment, CI, scheduled restore-verified backups and operational alerting remain unverified/pending in project notes. Optional monitoring integration exists in the API.                                                        | Verify deployment configuration and recovery procedures separately.                                                                 |

Expense attachments, payables, approvals, recurring expenses and split allocations are also explicitly outside the current Expenses release; they should not be mistaken for broken existing controls.

## Feature coverage

“Passed” below means the exercised cases passed, not that every possible scenario is proven correct. Browser checks use a fake API; database integration checks exercise the real API separately.

| Feature                                                  | Fresh evidence                                                                                    | Assessment                                                                              |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Sign-in, sessions, first-login password change, recovery | Auth/unit/database coverage; 4 recovery/onboarding E2E cases; onboarding browser flow             | Implemented; password-change concurrency bug above remains.                             |
| Staff, roles, branches and permissions                   | Frontend suite; catalog/access tests; onboarding setup, failure/retry and creation browser checks | Implemented; broad role-by-role manual acceptance is not exhaustive.                    |
| Suppliers, stock items, payment methods                  | Catalog routes: 34 passing E2E cases; frontend suite                                              | Implemented in covered cases.                                                           |
| Products, categories, recipes and branch menu            | Simple products: 22; categories: 9; branch products: 4 passing E2E cases                          | Implemented; retired pricing/template/request routes are intentional.                   |
| Inventory balances, adjustments and history              | Inventory routes: 17 passing E2E cases                                                            | Implemented in covered cases.                                                           |
| Reorder/target levels and suggestions                    | Stock levels: 7 passing E2E cases; frontend tests                                                 | Implemented. Existing starter thresholds were not changed by this audit.                |
| Supplier receiving                                       | 13 passing E2E cases; frontend tests                                                              | Implemented in covered cases.                                                           |
| Direct purchases/restocking                              | 5 passing E2E cases; browser creation/retry/confirmation reached                                  | Implemented; original browser script stops on an outdated exact-text expectation.       |
| Dispatch sending, receiving and discrepancies            | 25 passing E2E cases, one fixture-related assertion failure; delivery browser checks              | Implemented in covered cases; test-suite repair needed.                                 |
| Late counts and receiving follow-up                      | 8 passing E2E cases; browser hold/return/validation/responsive checks                             | Implemented with the approved-report correction gap above.                              |
| Manual count reminders                                   | Focused suite exercises reminder behavior; isolated receive/remind concurrency case passes        | Test migration round-trip corrupts its own later schema assumptions; see below.         |
| POS, sale completion, voids and history                  | Sales: 16 passing E2E cases; frontend suite                                                       | Implemented in covered cases; no offline/discount workflow.                             |
| Register shifts, cash movements and business day         | Shifts: 4 passing E2E cases; shift report browser passes                                          | Implemented; original full shift browser script has a stale header role selector.       |
| Daily reports, return, approval and stock reconciliation | 7 passing E2E cases; frontend suite                                                               | Implemented in covered cases; historical approved-report corrections remain absent.     |
| Work schedules and My schedule                           | 4 passing E2E cases; schedule component/helper tests                                              | Implemented in covered cases.                                                           |
| Expenses and categories                                  | 15 passing E2E cases; full expense browser workflow                                               | Implemented, including retry, corrections, voids, cash-out linkage, filters and export. |
| Dashboard and attention items                            | 7 passing E2E cases; frontend suite                                                               | Implemented; old broad browser script expects an obsolete dashboard label.              |
| Sales report, profit and CSV/PDF                         | 3 passing report E2E cases; 4 general export cases; component tests                               | Implemented; pending-filter export bug above remains.                                   |
| Notifications and audit log                              | 11 notification cases and 5 audit cases pass; notification scrolling browser passes               | Implemented; historical migration round-trip test is stale.                             |
| Toasts, appearance and responsive interactions           | Frontend suite; visible expense/onboarding feedback and responsive/theme browser checks           | Implemented. Old backlog claims about missing Sonner toasts are superseded.             |

## Verification results and engineering debt

| Check                                                 | Result                                                                                                                                                        |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frontend unit/component suite                         | **850 passed**, no failures/skips                                                                                                                             |
| API unit suite, excluding ignored historical checkout | **251 passed**, 47 opt-in tests skipped                                                                                                                       |
| Full API E2E run on disposable database               | **230 passed, 3 failed, 15 skipped**; 4 files marked failed, including a reminder-suite setup failure                                                         |
| Opt-in database unit/migration suite                  | **44 passed, 6 failed**, no skips                                                                                                                             |
| Production builds                                     | Both passed                                                                                                                                                   |
| Frontend TypeScript and ESLint                        | Passed                                                                                                                                                        |
| API ordinary lint and configured type-aware lint      | Exit 0; type-aware lint reports warnings, primarily class-instance spread in DTO-based code/tests                                                             |
| Unmodified browser scripts                            | Staff onboarding, expenses, notification scrolling, receiving follow-up and shift report passed; operational, purchases and full shifts stopped on assertions |

Do not add these counts into one unique-test total: some checks overlap. All main disposable runners confirmed database disposal. Application code was not altered to make checks pass.

### Integration/test maintenance findings

1. **Dispatch assertion uses a growing shared fixture array.** `test/dispatches.e2e-spec.ts:768` appends surplus items to `stockItemIds`; the later insufficient-stock case at `993–1010` sends every item but expects the error to name only Dispatch oil. It can legitimately report an insufficient surplus item instead. The expected 400 is returned; the assertion prevents the remaining rollback assertions from running. Do not call this proof of a rollback bug.
2. **Reminder round-trip restores historical constraints into a newer schema.** `test/count-reminders.e2e-spec.ts:206–207` directly runs the older reminder migration down/up after all migrations have been applied. That historical constraint lacks `DISPATCH_RECEIVED`, introduced later. The subsequent receiving test gets a constraint error/500. Running the receive/remind concurrency case alone against the fully migrated database passes. In the full combined run, the suite also failed at setup and skipped ten tests; its JSON reporter did not preserve the setup error, so that particular cause remains unconfirmed.
3. **Two notification/receiving migration round-trips omit later dependencies.** `notifications.e2e-spec.ts:725–741` attempts to remove register cash tables still referenced by newer schema. `receiving-followup.e2e-spec.ts:636–645` restores older notification constraints while newer event kinds exist. These are failures of the historical rollback test sequence, not evidence that ordinary current-schema receiving fails.
4. **Six opt-in historical migration assertions need repair/investigation.** Access-control testing calls a current repository against a schema without the later `coms_auth` rename; direct-workflow testing compares historical permissions with the current catalog; two simple-product tests migrate through later category requirements without the required legacy mapping; two timestamp assertions assume older user columns/date-field lists. A fresh empty database successfully applies all 49 migrations, but historical upgrade/rollback verification is not green.
5. **Browser harness drift blocks broad acceptance coverage.** `operational-browser.cjs:473` expects “Total Revenue”; the current dashboard has changed. `purchases-browser.cjs:214` expects exactly “On hand 22.75 Kilograms”, while the current restock form correctly adds the target preview “→ 40”. `shifts-browser.cjs:187–190` expects the header Start shift control to have link semantics; browser DOM inspection confirms an anchor with `role="button"`. Temporary diagnostic copies progressed past these assertions, then stopped on other old link-role selectors (View purchases and the POS Start shift control). These scripts did not complete and are not counted as passes. Update selectors and review navigation semantics, then rerun complete flows before treating the browser suite as a release gate.
6. **Discovery and skipped cases need explicit configuration.** An ignored API `.tmp` checkout contains old tests, so audit runs excluded `.tmp/**`. Five historical menu/product upgrade E2E cases remain skipped. Old blanket backlog statements about failing frontend tests are not reproduced: the complete current frontend suite is green.

## Evidence and follow-up order

Local, ignored artifacts are under each repository's `node_modules/.cache/feature-audit/`: JSON unit/E2E reports, build/lint logs, browser logs, `auth-race.json` and `sales-export-repro.log`. Browser captures remain under `coms-app/test-results/`. These are development evidence, not committed business data.

Recommended order: fix the password-change race; fix export context consistency; repair the failing/obsolete tests; decide historical report correction; prioritize the remaining backlog with the business. Production deployment and a complete real-browser-to-real-API acceptance run remain separate verification work. No production environment was inspected.
