# Local dispatch reset — 2026-10-23

The user requested deletion of all dispatch data and explicitly selected undoing dispatch stock movements. Applied only to local `coms-db`.

- Deleted 15 dispatches, 19 dispatch items, 10 receipts, 14 receipt items, 27 dispatch events, 3 discrepancies and 5 discrepancy events. No saved resolutions or late counts existed.
- Reversed the net effect of 31 dispatch-linked movements on 20 commissary/branch balances, then removed those movements. For Fish Sauce, commissary stock returned to 40 L and Manila–Ermita stock to 1.80 L.
- Removed 9 dispatch/receiving notification events and their recipients, plus 6 receiving reminder sources. No delivery-exception rows existed.
- Recalculated 17 affected item summaries across 3 draft daily reports using the existing ledger calculation. Preserved physical counts, waste and adjustment entries, report headers, and report history.
- Checked exact data hashes to preserve supplier deliveries, suppliers, stock items, products, sales, sale lines, legacy requests, and every non-dispatch stock movement.

## Backup and verification

Full custom-format backup: `Documents/COMS Backups/coms-db-before-dispatch-reset-2026-10-23T10-36-54-375Z.dump` (outside the repositories and vault). The adjacent `dispatch-reset-20261023.json` records the backup SHA-256, source fingerprint and applied result. No credentials or database contents are stored in this repository.

Restored the backup into a disposable database and rehearsed the complete cleanup successfully before applying. The live cleanup checked the source fingerprint, locked related tables, reversed movements, removed dependencies and refreshed draft totals in one transaction. Assertions checked expected balances, zero remaining dispatch data and preserved unrelated data before commit. A separate read-only check confirmed the committed result: zero dispatches, items, receipts, discrepancies, dispatch movements and receiving notifications; 3 reports and 410 unrelated stock movements remain. The disposable database and temporary cleanup script were removed.

This is a maintenance record, not a migration or an application delete feature. The local schema remains at migration 41; production was not touched.
