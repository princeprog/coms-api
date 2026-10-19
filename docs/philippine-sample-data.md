# Philippine development sample data

Run from `coms-api` against the local development `.env`:

```powershell
pnpm seed:philippines --check
pnpm seed:philippines --apply
```

The default and `--check` execute the seed and verification in a transaction, then roll back. Only `--apply` commits. Remote database hosts and `NODE_ENV=production` are rejected. The script uses the one existing active protected Super Admin as the opening-stock actor; it does not create users, change roles or assign branches.

The dataset contains eight Metro Manila branches (including two Takeout-only express locations), eight fictional Philippine suppliers, 40 stock items, 30 Filipino menu products with illustrative PHP prices, 240 branch menu assignments and six payment methods. Existing names are matched case-insensitively, so Cash and GCash are reused. Supplier emails use reserved `example.com` addresses; phone numbers are intentionally empty. These are fictional sample businesses, not actual supplier contacts or current price quotations.

Opening inventory includes 40 commissary balances and 320 branch balances. Each is paired atomically with an `ADJUSTMENT` ledger entry, attributed to the existing Super Admin with reason `Philippine sample data - opening stock`. Quantities vary by location and stock unit. These are sample opening counts, not supplier receipts, dispatches or sales.

The script uses stable IDs, skips existing records and balances, and does not replenish stock on reruns. Matching preexisting stock items, products and branches are not given sample stock or new menu assignments. Existing sample records retain later user edits, including disabled menu entries. New branch offers use the product's shared price and only services supported by both product and branch. Retired recipe and per-branch pricing tables are not populated.

Before committing, checks verify preservation of existing catalog, inventory and access records; exact stock-to-ledger reconciliation; menu price/service consistency; and a second seed pass that must add nothing. The complete operation rolls back if a check fails.

Applied on 2026-10-19 to local `coms-db`: 8 branches, 8 suppliers, 40 stock items, 30 products, 240 menu entries, 4 new payment methods (existing Cash/GCash retained), and 360 balances with 360 ledger entries. A fresh post-commit dry run added zero records.

Product categories are required after migration `20261019235124_product_categories`. New sample products use the explicit name-to-category mapping in `scripts/philippine-sample-data.ts`, validate that the mapped category is active, and hold a category lock during insertion. Existing products retain later category assignments and category renames. The script does not guess or create replacement categories. Fresh disposable verification created all 30 sample products and 240 menu entries inside a dry run, passed repeat-run checks, then rolled back. The migrated local database dry run adds zero rows.
