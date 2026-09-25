# Editable Predefined Roles

## Goal

Seed three ready-to-assign operational roles with editable permissions. At the time this plan was written, it retained `SUPER_ADMIN` and `NO_ACCESS` as protected system roles. The later 2026-09-26 removal decision superseded that part: `NO_ACCESS` was removed through a forward migration, while `SUPER_ADMIN` remains the only protected system role. Work directly on the current `dev` branches, preserve existing commits and unrelated authentication changes, use one agent, and do not push.

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

- [x] API migration: add `auth.roles.is_predefined` default false, insert the three roles and exact permission links atomically, fail on code/name conflicts or missing catalog entries, and guard rollback against assigned/edited roles.
- [x] API contract: expose server-owned `is_predefined` in role list data without changing auth context, endpoints, mutation payloads, or authorization behavior.
- [x] App: validate and show System/Predefined/Custom; allow authorized edits to active predefined roles through the existing editor; explain that permission changes affect all assigned staff.
- [x] Verification: migration integration, role API tests, frontend component/fixture tests, relevant browser checks, lint and builds.
- [x] Documentation: update COMS permissions, access workflow, architecture decisions, runbook, and progress with grants, migration behavior, evidence, and commit IDs.

## Data and security rules

Migration runs once through Kysely migration tracking. No startup sync, grant merge, or reset-to-default operation may overwrite administrator edits. Existing accounts, role assignments, custom roles, system role grants, branch scope, and workflow restrictions stay unchanged. A conflicting code or unique role name aborts the migration atomically with a useful error.

Rollback removes seed roles only when no users are assigned and name, active/system state, and permission set still match the seed. Otherwise it must abort without changes. A successful rollback drops only the added metadata column and seed rows.

## Commits

1. API migration, generated Kysely types, and migration tests — `a68a86c`.
2. API response metadata and role regression tests — `be36224`.
3. App schema, badges/editor guidance, fixture updates, and component tests — `71617cb`.
4. App responsive role-create correction after browser verification — `ee29756`.
5. App async-transition test stabilization — `1f5b6ce`.
6. Verification record and this completed plan — documented after final checks; the plan is this file.

Before every commit, verify the repository is on `dev`, stage explicit paths, inspect the staged diff, and run focused checks. Exclude the existing API authentication work from every role commit.

## Verification results — 2026-09-26

- API: `pnpm test` passed 80 tests; 25 tests were skipped in the ordinary suite. `pnpm lint`, `pnpm build`, and `pnpm exec tsc --noEmit` passed. The focused disposable PostgreSQL migration suite passed 3 tests with `COMS_RUN_DB_TESTS=1`, covering initial grants, persistence and guarded rollback. The local development migration was applied after its target and restorable backup were verified; the local account and existing role assignments were not changed.
- App: `pnpm test` passed 450 tests across 109 files; `pnpm lint`, `pnpm build`, `pnpm typecheck`, and changed-file Prettier passed.
- Production browser fixture: all 24 operational route states passed at 195, 390, 768, 1440, and 1920 CSS pixels, in dark mode, and at 2x scale/195px. It also passed the create-role permission-only scrolling checks at phone heights, predefined Branch Manager permission editing, shared-shell navigation/refresh, and the existing report flow. This browser uses deterministic simulated API responses; it does not verify real API transactions or use a real account. Migration integration uses disposable databases.
- The first browser pass exposed a zero-height permission scroller at 390×667; the create form was compacted and the production browser suite passed on rerun. A flaky unrelated async-transition assertion was changed to wait for completion; the full suite then passed.
- App commits on the existing `dev` branch: `1f5b6ce`, `71617cb`, and `ee29756`. API commits: `a68a86c` and `be36224`. No push or branch switch was performed. Existing uncommitted API authentication work remains unstaged and unchanged.
