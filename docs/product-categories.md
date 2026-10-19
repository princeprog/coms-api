# Product category API contract

Implemented in coms-api. Local migration `20261019235124_product_categories` is applied to `localhost:5432/coms-db`; 27 migrations are applied, none pending. Production has not been migrated.

## Categories

All routes use gateway authentication, session authentication and current database access control.

| Route                                   | Access                                 | Input                                   | Result               |
| --------------------------------------- | -------------------------------------- | --------------------------------------- | -------------------- |
| GET /product-categories                 | Protected Super Admin                  | search, is_active, page, page_size      | Category page        |
| GET /product-categories/available       | products.read or protected Super Admin | search, page, page_size                 | Active category page |
| POST /product-categories                | Protected Super Admin                  | {name}                                  | Active category      |
| PATCH /product-categories/:id           | Protected Super Admin                  | {name?, is_active?}, at least one field | Category             |
| POST /product-categories/:id/deactivate | Protected Super Admin                  | No body required                        | Archived category    |

Category: `{id, name, is_active, created_at, updated_at}`.
Page: `{items, total, page, page_size}`; default size 10, max 100, sorted by name then ID.
Names are trimmed, 2–80 characters, and unique without case sensitivity including archived records.
Validation errors return 400; unknown category IDs return 404; duplicate names and attempts to archive categories with active products return 409.
PATCH with is_active=false uses the same archive check as the explicit action. Reactivation uses is_active=true.
The active selector accepts no status override.

## Products

Create and full setup require UUID `category_id`; PATCH may omit it, but rejects null.
An explicit assignment must reference an active category. Unknown categories return 404 and archived selections return 409.
An inactive historical product can retain an archived category on an unrelated partial edit.

Every product response (list/detail/create/update/deactivate/setup) includes required:
`category_id: string`, `category_name: string`, `category_is_active: boolean`.
Setup retains its existing `{product, branch_ids}` wrapper.
Category assignment participates in the existing transaction, setup revision and actor-bound idempotency fingerprint.
Successful stored retries missing category fields receive that metadata without replaying writes.
Category-only product changes increment setup_revision but do not increment price_revision.

## Branch menu and POS

Every branch-product response includes the same three category fields, including single-product refreshes after PRICE_CHANGED.
GET /branches/:branchId/products accepts optional UUID `category_id`. It is combined with existing filters before count, limit and offset.

GET /branches/:branchId/products/categories returns an array of `{id, name}`, sorted by name then ID.
It requires branch_products.read and branch scope, and accepts optional service_type=DINE_IN|TAKEAWAY.
It returns distinct active categories represented by available, active products eligible for the branch and selected service.
The list does not depend on product search, category selection or product pagination; clients should send only service_type.
The static route precedes :productId. An unknown branch returns 404; an inactive branch has an empty eligible list for permitted readers.
Retired recipe routes remain 404. Sale payloads, financial snapshots, stock semantics and price revision rules are unchanged.

## Migration and verification

The migration seeds Rice meals, Silog meals, Chicken, Noodles, Sides, Desserts, Beverages and archived Legacy items.
It locks products, maps exact approved names, reports/fails unknown names or active Legacy items, and adds a required indexed category foreign key.
The local 36-product distribution is 11/4/1/2/5/3/7/3 in that order.
All prior product fields were compared before/after local application and preserved exactly.

Product saves hold a shared category row lock through commit. Category archive holds an exclusive row lock, then checks active products and updates in the same transaction.
Archive does not lock product rows, avoiding a reverse lock dependency with the product-save branch/product/category lock order.

Focused verification:

- Disposable copy: all 36 exact local mappings; atomic unknown-name failure; uniqueness, required FK, up/down/up; generated schema.
- 9 category e2e tests: permissions, validation, pagination, transitions, revision/retry normalization, filters, migration backfill and concurrent locks in both directions.
- Existing simple-product/catalog suites: 54 passing tests, including financial-sale and historical-void checks.
- Branch products: 4 passing tests. Pagination database checks: 7 passing tests. DTO/menu contracts: 43 passing tests.
- Full TypeScript check, Nest build and lint pass.
- Local sample script dry run preserves existing records and adds zero rows. A fresh disposable dry run verifies all 30 new product assignments, 240 menu entries, repeat-run idempotency, and rollback.

Run `node scripts/verify-product-categories.cjs` for disposable verification against a copy of the local product catalog; it regenerates db.d.ts from the disposable schema and never migrates the source database.
Run focused e2e with `node scripts/test-disposable-db.cjs test/product-categories.e2e-spec.ts`.
