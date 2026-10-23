# Stock items counted in daily branch reports

Stock items expose `daily_count_required`, a boolean defaulting to `true`. Users with `stock_items.create` or `stock_items.update` can set it through the existing stock-item endpoints. Omitted create values default to true; omitted update values preserve the saved setting. Nulls, strings and numbers are rejected. Existing stock-item audit triggers record setting changes.

In Stock items, create or edit an item and uncheck **Include in daily branch counts** for items counted periodically. This is a global item setting across branches. Periodic counts remain manual inventory adjustments; this change does not introduce scheduling or reminders.

New daily reports include only eligible items from the branch's existing reportable stock. The saved report-item list is the snapshot: changing the setting never adds or removes items from existing drafts, returned, submitted or approved reports, including create retries. Existing items still require their counts and are reconciled normally even if the stock setting is later disabled.

Excluded items need no physical count and generate no report reconciliation movement. Receiving, dispatches, recipe consumption, voids and manual stock adjustments are unchanged. If no items need daily counting, the branch can still create, submit and approve its sales report; normal day-end, shift, delivery, permission and approval requirements apply, except for the separately documented development submission bypass.

## Rollout

Apply `20261023230556_stock_item_daily_count_required` before deploying the API, then deploy the app. All existing items default to daily counting; existing report rows are unchanged. Regenerate Kysely types after migration. The migration rollback refuses while any stock item has an exclusion, avoiding silent loss of those settings. Prefer retaining the additive column when rolling back application code.
