# Editable Predefined Roles

## Goal

Seed three ready-to-assign operational roles with editable permissions while keeping `SUPER_ADMIN` and `NO_ACCESS` protected. Work directly on the current `dev` branches, preserve existing commits and unrelated authentication changes, use one agent, and do not push.

## Default roles and grants

Action suffixes below are prefixed by their module key (for example, `sales.create`). A dash means no grants.

| Module              | Commissary Manager                        | Branch Manager               | Cashier      |
| ------------------- | ----------------------------------------- | ---------------------------- | ------------ |
| `roles`             | —                                         | —                            | —            |
| `staff`             | —                                         | —                            | —            |
| `branches`          | read                                      | read                         | read         |
| `suppliers`         | read, create, update                      | —                            | —            |
| `stock_items`       | read, create, update                      | read                         | —            |
| `inventory`         | read, adjust                              | read                         | —            |
| `supplier_receipts` | read, create, post                        | —                            | —            |
| `stock_requests`    | read, approve, reject                     | read, create, cancel         | —            |
| `dispatches`        | read, create, dispatch, shortage_close    | read, receive                | —            |
| `products`          | read, create, update                      | read                         | —            |
| `recipes`           | read, create, update                      | —                            | —            |
| `branch_products`   | read, create, update, availability_update | read, availability_update    | read         |
| `sales`             | read                                      | read, create, void           | read, create |
| `daily_reports`     | read, return, approve                     | read, create, update, submit | —            |

Starter roles are active, `is_predefined=true`, and `is_system=false`. Grants are explicit and frozen in the migration. Branch assignments remain separate; do not grant role/staff administration or deactivation by default. `inventory.adjust` stays with Commissary Manager because it also allows commissary adjustments.

## Implementation tasks

- [ ] API migration: add `auth.roles.is_predefined` default false, insert the three roles and exact permission links atomically, fail on code/name conflicts or missing catalog entries, and guard rollback against assigned/edited roles.
- [ ] API contract: expose server-owned `is_predefined` in role list data without changing auth context, endpoints, mutation payloads, or authorization behavior.
- [ ] App: validate and show System/Predefined/Custom; allow authorized edits to active predefined roles through the existing editor; explain that permission changes affect all assigned staff.
- [ ] Verification: migration integration, role API tests, frontend component/fixture tests, relevant browser checks, lint and builds.
- [ ] Documentation: update COMS permissions, access workflow, architecture decisions, runbook, and progress with grants, migration behavior, evidence, and commit IDs.

## Data and security rules

Migration runs once through Kysely migration tracking. No startup sync, grant merge, or reset-to-default operation may overwrite administrator edits. Existing accounts, role assignments, custom roles, system role grants, branch scope, and workflow restrictions stay unchanged. A conflicting code or unique role name aborts the migration atomically with a useful error.

Rollback removes seed roles only when no users are assigned and name, active/system state, and permission set still match the seed. Otherwise it must abort without changes. A successful rollback drops only the added metadata column and seed rows.

## Commits

1. API migration, generated Kysely types, and migration tests.
2. API response metadata and role regression tests.
3. App schema, badges/editor guidance, fixture updates, and component tests.
4. Verification and documentation updates in the relevant repositories.

Before every commit, verify the repository is on `dev`, stage explicit paths, inspect the staged diff, and run focused checks. Exclude the existing API authentication work from every role commit.
