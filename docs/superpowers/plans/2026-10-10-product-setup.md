# Stock usage and product setup implementation plan

> Execution: solo, in the existing workspace. Preserve pending changes in both repositories. User has approved implementation; no additional review gate, subagents, commit, push or deployment.

**Goal:** Explicit stock usage and one product setup workspace for prepared products, direct-sale stock, packaging and authorized branch prices.

**Architecture:** Extend the current NestJS/Kysely modules and Next.js feature boundaries. Continue storing all product consumption in product_ingredients so sales and void snapshots stay compatible. Add transactional, idempotent setup saves with independent permission checks per section.

**Spec:** Latest approved conversation proposals: stock usage is separate from category; ingredient, packaging, ready-to-sell and operating supply usages; simpler dedicated product/recipe setup; central ownership with branch requests; visible menu blockers.

## Contracts and constraints

- stock_items.usage_types is a nonempty unique array of INGREDIENT, PACKAGING, READY_TO_SELL, OPERATING_SUPPLY. New API creation requires an explicit choice. Existing referenced stock is backfilled INGREDIENT; other stock is OPERATING_SUPPLY. Never infer usage from names/categories.
- products.preparation_type is PREPARED or READY_TO_SELL; setup_revision protects product metadata. product_ingredients.component_type matches an allowed stock usage. Legacy lines default INGREDIENT.
- Prepared products require an INGREDIENT for every permitted service. Direct-sale products have exactly one READY_TO_SELL component in ALL scope, no ingredients, plus optional packaging. Prepared products can also contain ready-to-sell accompaniments.
- Keep the existing 100-component limit, positive decimal strings, ALL/DINE_IN/TAKEAWAY scopes and duplicate-stock-within-scope rule.
- Reject removal of a stock usage that is referenced by a current product component. Active stock is required for saves and sales. Voids always use historical snapshots.
- Product setup accepts optional product, recipe and prices sections. Each section requires its existing capability. Branch prices require authorized branch scope and expected revisions. No new grants.
- Setup saves require a UUID Idempotency-Key; successful retries return the saved result and mismatched key reuse conflicts. All sections commit together. Lock branches, product, stock, then prices consistently.
- GET setup returns only prices for authorized branches. Full edit requires product read and recipe read. Recipe-only editors retain their existing route and capabilities.
- Keep backend pagination/search/filtering; 350ms lookup debounce; all unauthorized branch writes rejected.

## Task 1: Schema and stock classification

Files: new forward migration, generated db.d.ts, stock-items DTO/service/repository; test/product-setup.e2e-spec.ts.

- [x] Write disposable database tests for explicit usages, filtering, invalid selections and preserving legacy data.
- [x] Run and observe failures on the missing contract.
- [x] Add guarded migration and stock API; reject classification removal used by recipes.
- [x] Test fresh/upgrade/guarded rollback; verify backup before local migration and regenerate types.

## Task 2: Product consumption and atomic setup

Files: products/product-setup DTO/controller/service/repository; recipes; menu-requests; menu-catalog readiness; sales transaction validation; tests.

- [x] Add tests for operating-supply exclusion, wrong component usage, direct-sale shape, exact service deductions/voids, setup permission/branch isolation, stale recipe/product/prices, atomic rollback and retries.
- [x] Run red tests, implement contracts, run focused database tests.
- [x] Reuse component validation across ordinary recipes, reviewed approvals and setup saves. Enforce eligibility in candidates and sales.

## Task 3: Stock UI and dedicated product setup

Files: stock-items schemas/forms/filter/table; products/setup schema/services/hooks/components; /products/new and /products/[productId]/setup routes; product actions; compact recipe components and request editors.

- [x] Add contract/UI tests for usages, mode-specific components, exact decimal draft validation, drafts on errors and setup actions.
- [x] Implement dedicated workspace with identity/services, mode, compact components, deduction previews and authorized central prices. Save once with permissions and revision handling.
- [x] Add stock usage chips and URL-backed usage filtering. Show component-type-filtered stock lookups.
- [x] Expose direct setup links from Products; preserve read-only and branch request paths.

## Task 4: Visible menu blockers and verification

Files: candidate lookup services/components, Add to menu dialog; docs and Obsidian notes.

- [x] Show eligible and blocked products with specific reasons and permission-aware setup/request links; blocked entries cannot be selected.
- [x] Browser-check central prepared/direct-sale setup, branch requests, menu candidate blockers, keyboard, mobile and both themes using disposable fixtures.
- [x] Run both complete test suites, relevant database tests, lint, type checks, formatting checks and production builds.
- [x] Review changes solo, record exact verification and skipped checks, update workflow/architecture/progress and release instructions.

## Review focus

Legacy consumption snapshots and voids; concurrent stock classification/price/recipe edits; partial custom grants; multi-branch pricing isolation; blank/blocked lookup versus transport errors; retries after successful saves and later configuration changes.
