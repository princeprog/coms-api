# Emma's catalog initialization — 2026-10-24

Applied the user's requested chicken-focused catalog to the existing COMS
Supabase project in Sydney (`lttpcjxgcgdiixouiygx`). The target was verified empty
of branches, stock items, products, menus, inventory movements, and sales before
the import. No schema changes were needed.

Created Cebu, Manila, and Davao with dine-in and takeout service, 40 stock items,
28 shared-price products, 84 branch-menu entries, and 141 recipe lines. Eleven
stock items require daily counts. Prices and portions are editable starter
values; see [the catalog guide](../emmas-starter-catalog.md).

Before application, backed up public and coms_auth in custom format outside the
repositories and vault under `Documents/COMS Backups/emmas-catalog-2026-10-24T10-16-14.628Z`.
Restored that archive into a disposable local database and applied the complete
catalog there. Verified repeat execution is a no-op, then dropped the disposable
database. The backup's verification manifest records its SHA-256 digest and
rehearsal counts; no backup or credentials are committed.

The production dry run passed with all writes rolled back. The application then
committed in one serializable transaction with catalog locks, Super Admin audit
attribution, and a named catalog initialization event. Fingerprints of unrelated
COMS tables matched. Existing accounts, passwords, operational records, costs,
and inventory were preserved. No opening balances or fake transactions were
created. Existing database RLS and privileges were unchanged.

Validation:

- Live API: exactly three branches and 40 stock items; all 28 products eligible
  at every branch for both service types; product setup exposes its recipe and
  all three branch assignments.
- Authenticated production pages: Branches, Stock Items, Products, and Branch
  Menu returned 200 with a valid session and no application error.
- Temporary verification sessions were removed; logout and refresh passed.
- Database: 3 branches, 40 stocks, 28 products, 84 menus, 141 recipe lines;
  one existing user; zero sales, dispatches, inventory movements, and stock costs.
- Security: zero unprotected COMS tables and zero tables readable by anon or
  authenticated Data API roles. Advisor reported only informational
  RLS-without-policy notices, consistent with the API-only access model.
- Catalog validation, import/repeat-run checks, syntax/formatting, and scoped
  lint passed. No interactive browser session or real sale was performed.

This is a data import, so it is visible immediately on the live application and
does not require redeployment. The importer and catalog definition are committed
locally on dev; no Git push is part of this request.
