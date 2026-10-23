# Confirmed dispatch surplus

A branch count records what arrived, even when it exceeds the sent quantity. Confirming that surplus must finish the dispatch without inventing commissary stock or changing the branch's saved count.

## Behavior

- Surplus resolution deducts the full confirmed quantity from commissary stock, even below zero. The existing closure and linked inventory movement retain the actor, reason and retry key.
- The branch already received its counted quantity; resolution never credits it again.
- Inventory displays negative commissary balances as **Below zero**. Staff reconcile the stock records through a genuine receipt or reasoned adjustment.
- Sending new stock still requires sufficient commissary stock. Ordinary manual deductions still cannot create negative stock.
- Keep existing variance bounds, permissions, separation of duties, transaction locking and idempotency.

Requiring an artificial stock increase before resolution obscures the discrepancy. Capping the deduction at zero loses stock movements. A signed balance preserves the full discrepancy and follows the existing branch-inventory approach for recorded consumption.

## Release and verification

Apply the forward migration before running the updated API. It removes only the commissary nonnegative check, preserving every balance and movement. Rollback refuses while negative commissary balances exist.

Verify the 40 L opening / 35 L sent / 45 L counted case on a disposable database: resolve 10 L to -5 L, retain 45 L at the branch, create one audited deduction under concurrent retries, mark the discrepancy resolved, show Below zero in inventory and reject new outgoing stock. Check a zero balance, decimals and an already-negative balance. Test migration rollback guards and recovery through adjustment/receipt paths.

For local rollout, verify a restorable backup outside the repositories and vault, apply only the next migration and regenerate types. Do not resolve the user's dispatch automatically: its reason and confirmation belong to the operator.
