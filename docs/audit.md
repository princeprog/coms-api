# Audit history

COMS keeps an append-only record of who changed settings, access and costs. Users with `audit.read` see it on the **Audit log** page (Administration). No role receives the permission by default; Super Admin sees everything.

## What is recorded

- **Field changes** on products, product categories, stock items, suppliers, branches, payment methods, business-day rules, staff accounts and roles. Database triggers write one event per insert, update or delete inside the same transaction, with `changes: { field: { from, to } }`. Timestamps, revision counters and password data are never recorded. Product category and staff role IDs are shown by their current name.
- **Named events**: role permissions changed (granted and revoked), staff branch access changed, staff password reset, sign-in, failed sign-in (with the email used), password changed, stock cost set (with the reason), product recipe changed, product branch availability changed, and CSV export downloaded.

A rolled-back change writes no event. Updates and deletes on `audit_events` raise an error.

## Who did it

The API sets the PostgreSQL setting `coms.actor_id` for each request's connection (`AuditContextInterceptor` and `createDatabase`), so trigger events carry the signed-in user. Events without a user, such as failed sign-ins or scripts, show as "System".

## API

`GET /audit-events?from&to&entity_type&search&page&page_size` (`audit.read`). Dates are Manila calendar days. Search matches the person, record name or action. Migration `20261021211712_audit_events` creates the table, triggers and permission.

