# Simplify Products and Branch Menus

Approved specification: the user's implementation plan in this conversation.

- [x] Guarded global-price/sale-marker migration; verified local backup and restore; fresh and upgrade tests; generated types.
- [x] Super Admin-only atomic product/price/branch saves and menu mutations; scoped read-only menus; retire recipes, pricing, requests and templates.
- [x] Financial sales without inventory deductions; global price conflicts/retries; strict historical void reversal.
- [x] Compact product form and simple Branch Menu; remove stock usage and retired workflows; preserve drafts/services and POS review.
- [x] Full API/app checks, disposable browser flows, solo review, workflow/release/Obsidian notes.

Constraints: preserve pending Dispatch Details and Inventory changes and ports 3005/3006. Retain retired database records. Never infer prices. No production deployment or commit/push requested.

Execution ledger
----------------

2026-10-10: Read current repository instructions and skills; both repositories are on dev with pending work. Execute in the existing checkout to preserve that work. User explicitly requires solo execution; final review will be a separate author review. Use real disposable PostgreSQL fixtures for integration checks.
Pre-flight: migration price/revision -> product/menu/POS contracts; atomic product branch selections -> menu actions; sale marker -> strict historical vs financial-only voids. Existing branch services remain intersected with product and branch capabilities.

Milestone 1–4 (2026-10-10): verified/restored backup, guarded migration 24 applied to local localhost/coms-db only, 51-table schema regenerated, and exact records in 23 business/access tables compared against restored backup unchanged. Migration cases: 4 passed. API contracts: Super Admin atomic product/price/branch saves, scoped read-only menus, retired endpoints, global price conflicts and successful retries, financial sales and strict historical voids. Full e2e: 13 files/124 passed, including existing historical upgrade suites using their own migration targets. Frontend focused: 15 files/80 passed; complete frontend: 116 files/523 passed before final void-copy refinement. New partial-update regression observed RED→GREEN: editing metadata cannot silently insert empty branch selections. Financial/historical void copy observed RED→GREEN (2 focused tests).
Ruling: preserve the historical permission catalog and old database grants, but exclude retired workflows and Super Admin-only writes from editable role capabilities and live custom-role access. Product/menu guards check the protected role directly. This preserves history while avoiding ineffective role controls; custom roles cannot gain these operations.
Ruling: remove tests for retired active request/template/recipe/setup workflows and replace them with current financial-sales and retired-endpoint regressions; historical migration/record-preservation tests remain. Their old behavior is intentionally unavailable.

Final milestone (2026-10-10): API 34 files/157 unit/database tests and 13 files/127 e2e cases passed without skips; frontend 118 files/525 tests passed. Both full lint checks, TypeScript, production builds, changed-TypeScript formatting (51 API / 150 frontend files) and whitespace checks passed. Current migration list confirms 24 applied and none pending; 23-table exact preservation was rechecked before disposing the owned restored clone, retaining the verified archive.

Final review: separate author review under the user's explicit solo instruction. Reviewed protected-role authorization despite old grants, scoped branch reads, required/forged/global prices, optional-update branch preservation, atomic selection and mirrors, retry identities and stale prices, no inventory in new sales/voids, and complete historical reversal integrity. Historical wrong-quantity, wrong-stock-item and missing-whole-line regressions were observed RED→GREEN; complete API suites passed after the fix. Compact currency and unavailable-session draft error regressions were also observed RED→GREEN; the complete frontend suite passed afterward. No remaining material findings.

Ruling: preserve the existing dev checkouts and pending changes, with no commit/push or integration step — the user explicitly requires preserving this work and has not requested a new commit in this task — the work remains local and uncommitted.
Ruling: complete the final review solo instead of dispatching an independent reviewer — the user's explicit solo instruction takes precedence — no independent second reviewer was used before delivery.

Browser evidence: real production app/API with disposable authenticated Super Admin, Branch Manager and Cashier sessions. Required price, zero initial branch choices, keyboard selection, shared price and disable/re-enable, outage draft/retry/unsaved protection, fixed read-only manager context and details, Dine-in and Takeout, explicit old/new price review, new sale void, retired route redirect and stock controls, responsive mobile/tablet and light/dark checked. A voided Dine-in sale retained 58.002 unit price and 116.004 total; the reviewed Takeout sale recorded 240.007. All six balances stayed 100 with no consumption or movements. Final builds repeated draft/retry and phone checkout (175.002) with inventory unchanged. Final browser warnings/errors empty. Captures and nonsensitive SQL evidence remain in ignored test artifacts.

Delivery: both disposable browser databases/processes and the verified upgrade clone cleaned up; archive retained outside the vault. Restored app/API at 3005/3006; API HTTP 200 and app sign-in verified, viewport reset and theme restored. Updated current workflow guide, release notes, retired-guide banners, QA, Obsidian Home/workflows/permissions/data model/decision/progress. Native zoom/text scaling, a real screen reader, exhaustive browser error matrix and independent delegation remain unperformed; production deployment and commit/push are outside the request. Replacement inventory consumption remains deferred.
