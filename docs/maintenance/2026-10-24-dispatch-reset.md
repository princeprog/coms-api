# Local dispatch reset — 2026-10-24

The user again requested deletion of all dispatch data and chose to undo dispatch stock movements, including for Manila – Ermita deliveries already reflected in its approved 2026-10-23 daily report. Applied only to local `coms-db`.

- Deleted 7 dispatches, 12 dispatch items, 7 receipts, 12 receipt items, 15 dispatch events, 4 discrepancies, 5 discrepancy events and 1 resolution with 1 item. No late counts, delivery exceptions or receiving reminder sources existed.
- Reversed the net effect of 23 dispatch-linked movements on 13 commissary and branch balances, then removed those movements. Commissary examples: Adobo Sauce Base +50 L to 80 L, Boneless Bangus +140 pcs to 240 pcs. Manila – Ermita examples: Adobo Sauce Base −45 L to 5.34 L, Boneless Bangus −130 pcs to 15 pcs.
- Removed 12 dispatch notification events (7 sent, 4 discrepancy, 1 resolved) and their recipients.
- Left all daily reports unchanged. The approved Manila 2026-10-23 report keeps its frozen figures, including the receipts it counted, so Manila's current stock is now below that report's physical counts; the next count will show the difference. The draft reports cover earlier dates and were not affected.
- Verified unchanged by hash: all non-dispatch stock movements, daily reports and report items, sales, supplier receipts, stock items and non-dispatch notifications.

## Backup and verification

Full custom-format backup: `Documents/COMS Backups/coms-db-before-dispatch-reset-2026-10-24T08-44-55-493Z.dump` (outside the repositories and vault), with an adjacent `.json` recording its SHA-256 and table-data entry count. No credentials or database contents are stored in this repository.

The backup was restored into a disposable database and the full cleanup was applied there first; post-commit checks passed and the copy was dropped. The live cleanup checked the expected row counts, locked the related tables, reversed balances, removed movements, notifications and dispatch rows, and asserted expected balances, zero remaining dispatch data and unchanged unrelated data before committing. A separate read-only check confirmed zero dispatch rows, dispatch movements and dispatch notifications, with 481 stock movements, 4 daily reports, 19 sales and 3 supplier receipts remaining. Temporary scripts were removed.

This is a maintenance record, not a migration or an application delete feature. The local schema is unchanged; production was not touched.
