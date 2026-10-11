# Branch Menu Implementation Plan

> Execute solo with superpowers:executing-plans. The user has approved the complete specification and execution method in this chat.

**Goal:** Branch-owned menus, centrally assigned prices, reviewed requests, reusable templates, and service-aware POS.

**Architecture:** Extend the existing NestJS feature modules and Next.js feature/service boundaries. PostgreSQL owns transactions, revisions, scoped queries and exact numeric calculations.

**Tech Stack:** NestJS, Kysely/PostgreSQL, Next.js, shadcn/Base UI, Vitest.

**Spec:** The user-approved "Branch menu ownership, central pricing, and service-aware sales" specification in this chat.

## Global constraints

- Solo execution. Preserve pending dispatch and inventory edits.
- Permission-based authorization, assigned-branch scope, no custom-role resets.
- Exact decimal text and immutable historical sale consumption.
- Dine-in/Takeout only; central prices do not vary by service.
- No automatic template synchronization, deployment, commit or push.

## Review focus

- Price revision conflicts must preserve cart and require review.
- Identical successful retries survive later configuration changes.
- Shared ingredient plus service-specific ingredient sums exactly.
- Approval must be atomic, revision-checked and never self-approved.
- Template reapplication preserves local menu settings.

## Tasks

- [x] 1. Red contract tests; additive schema, backup/restore, generated types and permission migration.
- [x] 2. Central pricing, menu candidates/eligibility, products and scoped recipe consumption, revision-safe POS API.
- [x] 3. Immutable branch requests, audited atomic decisions and scoped queues.
- [x] 4. Versioned templates, transactional preview/apply and idempotent history.
- [x] 5. Branch Menu/pricing UI, service-aware recipes/products/branches and POS price review.
- [x] 6. Requests/templates UI, permission-filtered navigation and bounded server lookups.
- [x] 7. Disposable database integration tests, browser fixtures, full suites, lint/types/builds, knowledge notes; verification limits recorded below.

## Execution ledger

- 01:43 checkpoint: disposable workflow suite expanded to **13 passing tests**, including rejection/cancellation, stale rejection, adjusted shared recipe approval, void after recipe revision, additive template application/missing-price reporting/retained removed membership, unsupported services and insufficient-stock atomic rollback. Disposable restored-backup upgrade suite **3 passing tests** covers exact legacy price/sale snapshots, unchanged custom grants, guarded rollback, safe rollback/reapplication. First upgrade fixture attempts failed on incorrect role-field and missing sale-status setup; fixtures corrected and final suite passed.
- New frontend routes: `/branch-prices`, `/menu-requests`, `/menu-requests/new`, `/menu-requests/[id]`, `/menu-templates`, `/menu-templates/new`, `/menu-templates/[id]`, `/menu-templates/[id]/edit`. Branch Menu uses server candidate lookup/no client price, one menu action trigger, price requests and service/availability actions. Service-aware recipe fields/preview, product service choices, branch takeout setting, and permission-filtered navigation added. POS state extracted into feature hook with TanStack mutations; explicit stale-price acceptance and service incompatibility tests pass (3 focused files / 16 tests).
- Frontend initial full suite: 15 failing files from old contracts/import mocks; subsequent focused run reduced to 2 failures, corrected. Current broader focused run is in progress. New menu controls React ref lint error fixed; lint also saw preexisting ignored `test-results/inventory-fixed-preview.cjs` imports, so production checks must exclude generated artifacts. Frontend components over 200 lines still require decomposition, query/service eligibility and sorting completion, accessible/error/loading checks, new request/template tests, browser evidence and all final checks.
- 2026-10-08 checkpoint: schema and permission migrations applied to verified local development target; 22 migrations now applied; generated Kysely types updated. Pre-migration archive restored to a disposable upgrade database with eight table counts matching.
- First API contract tests: 4 red then green. Disposable fresh-database workflow tests: 9 passed, covering scoped authorization, server-owned prices, exact scoped consumption, successful retries after price changes, stale price rejection, void snapshots, adjusted request approval and rollback, and template preservation/idempotency.
- Frontend contract tests: 3 red then green. Frontend and API TypeScript checks pass at this checkpoint. Actual frontend workflows, broader database/upgrade coverage, architecture cleanup, browser verification, full checks, and final knowledge updates remain outstanding.
- Initial: API clean on dev. Frontend contains existing Dispatch Details and Inventory changes; preserve them.
- Target verified: localhost:5432/coms-db; 20 migrations applied.
- Ruling: Retain existing dev checkouts to preserve current running app and pending work. No subagents or unsolicited commits.
- Ruling: User's supplied plan and explicit implementation instruction satisfy the design/plan review gates; execute continuously.

- 03:26 verification: full API unit/database suite 32 files / 154 tests and complete e2e suite 13 files / 135 tests passed with no skipped cases, including fresh schema and restored-backup upgrade. Typed lint is blocked by Windows failing to spawn tsgolint.exe (UNKNOWN); syntax oxlint, TypeScript and API production build pass. Existing Vite/Observe worker warnings remain visible in logs.
- Full frontend suite 119 files / 543 tests passed after confirmation dialogs and focused component splits. A first split attempt failed compilation; fixed the effect boundary, reran the complete suite green. ESLint subsequently required the hook-returned ref to use the latestRef convention; naming fixed, final lint/types/build running. No functional test assertions weakened. Changed-file formatting: frontend 141 / API 53 clean before the final ref rename.
- Browser so far: real disposable manager login; fixed branch context; keyboard candidate selection and centrally priced add; independent services; price request; dedicated incomplete new-product submission; central queue and adjusted price draft. Native window.confirm stalled the IAB before approval; replaced every new menu native confirmation with shadcn AlertDialog. Confirmation/retry tests 5/5 pass. Final production browser review, cashier and template applications remain in progress.
- Final review: self-review (explicit solo instruction excludes independent subagents). Checked permission/service boundaries, transaction lock ordering, revision/idempotency contracts, snapshots, URL-backed queries and draft preservation. Added red-to-green regressions for unauthorized explicit central queue branch and misleading blocked state when takeout packaging is inactive but dine-in is eligible.

## Final delivery evidence — 04:12 PHT

- Final API unit/database run: **32 files / 154 tests passed**. Complete e2e: **13 files / 135 tests passed**, no skipped cases. Fresh menu workflow cases 17/17 and restored-backup upgrade cases 3/3 are included. Final logs: `.tmp/menu-all-unit.log`, `.tmp/menu-all-e2e.log`, `.tmp/menu-all-checks-final.log`.
- Final full frontend delivery run: **119 files / 543 tests passed** with `--maxWorkers=2`. A prior default-parallel run hit two existing staff-form failures (assignable-role creation timeout and branch-search lookup); staff 7/7 passed alone and two complete bounded runs passed. No assertion/timeout relaxation. Logs: `coms-app/test-results/menu-full-tests-final.log`, `menu-staff-recheck.log`, `menu-full-tests-final-bounded.log`, `menu-full-tests-delivery.log`.
- Both production builds, TypeScript checks, frontend ESLint, API syntax and type-aware oxlint passed. The earlier Windows tsgolint spawn error cleared on final retry without weakening security. Four non-blocking typed-lint warnings concern intentional validated DTO fields projected into plain persistence data; no prototype methods are needed. Existing Vite/Observe warnings remain in successful API tests.
- Final changed-file formatting: **142 frontend / 53 API files clean**, generated Kysely declarations excluded. Git whitespace checks pass. Final UI review aligned menu/request/template/POS statuses with project solid color/white-text conventions and completed shadcn DropdownMenuGroup composition. Product-request outcome copy now describes approved or closed outcomes correctly.
- Real browser verification used production builds, real auth/permission guards and disposable PostgreSQL records. Manager: fixed one-branch context, keyboard candidate selection, read-only central price, menu creation, independent service restriction, price request, incomplete product request, recipe request, dirty-draft retention and requester cancellation. Central: scoped queue, adjusted price approval 125→124.5, complete new-product approval at 149 without automatic menu creation, recipe proposal 0.12→approved 0.11/revision 2, template membership edit/revision 2. Template application: missing-price block, eligible addition, preservation of a Takeout-only existing item/124.5 price, skipped-item report and disabled repeated application when no additions remain.
- Cashier: explicit service selection for dual-service branch; Takeout-only automatic default; quantities retained at 2 while changing to incompatible Dine-in; blocked checkout; stale price 124.5→128.75 requiring explicit acceptance; recorded total 257.5. Saved takeout deductions: chicken 0.2 kg plus 2 boxes. Dine-in at 135 consumed chicken 0.1 kg and no box. Later recipe approval preserved existing sale snapshots.
- Desktop, 390px mobile and 768px tablet reflow checked. Key Branch Menu, request/template and POS states inspected in light/dark themes with no document overflow; keyboard dialogs/menus/service choices checked. Browser warning/error logs empty. Screenshots in `coms-app/test-results/branch-menu/`, including `menu-desktop-final.png` and `pos-price-review.png`. IAB native confirm stalled an earlier test; new menu flows now use shadcn AlertDialog and final verification ran through the available Brave connector. A real screen-reader session, native zoom/text scaling and an exhaustive browser matrix of every error/state were not run; automated component/integration state coverage passed.
- Disposable browser databases and test processes closed; exact pre-migration disposable upgrade clone removed after tests, verified archive retained outside the vault. Development `coms-db` confirms **22 applied migrations**. No production migration/deployment, commit or push. Pending Dispatch Details and Inventory edits preserved.
- Obsidian Home, Permissions, Access/Branches, Products/POS, Architecture Decisions and Delivery/Progress updated. Coordinated release instructions: `docs/branch-menu-release.md`. Release requires a fresh verified target backup, migrations, API then app and refreshing open POS clients. Solo author self-review completed; independent review was not used per user instruction.
