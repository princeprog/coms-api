# Date and time storage

COMS stores every persisted instant as PostgreSQL `timestamptz` in both `auth` and `public`: creation/update times, authentication expiry/revocation/consumption, dispatch and receipt audit events, sales, report approvals and notifications. API datetime inputs carry `Z` or an explicit UTC offset. Responses serialize instants as ISO 8601 strings; operational displays use `Asia/Manila`.

Calendar-only values remain `date`: branch opening, supplier receipt date, report business date, actual delivery date and reminder date. JavaScript dates, epoch numbers, timeline properties named `timestamp`, and Kysely-codegen's `Timestamp` alias are application representations, not timezone-less SQL columns. The generated alias is shared by both PostgreSQL timestamp types and may stay unchanged after schema generation.

The report expression `business_date::timestamp AT TIME ZONE 'Asia/Manila'` intentionally converts a local midnight into a `timestamptz` instant. Replacing its intermediate cast with `timestamptz` reverses the conversion and makes results session-dependent. Existing historical migrations are immutable; a fresh database reaches the corrected schema by running the full migration chain.

## Upgrade

Migration `20261020213119_use_timestamptz_for_auth_times` converts the remaining 12 legacy columns in `auth.users`, `auth.sessions`, `auth.token_families` and `auth.refresh_tokens`. All 74 operational/access timestamps already used `timestamptz`.

The migration uses an explicit source zone, independent of the migration connection's TimeZone. The default is `Asia/Manila`, based on verified local UTC+8 database defaults and Node writers. For another installation, audit historical database and application writer zones first, then set `COMS_LEGACY_TIMESTAMP_TIME_ZONE` to the verified IANA zone if different. Mixed writer zones require a separate data reconciliation; one override cannot recover lost offsets. Invalid zone names abort before any conversion.

1. Verify the database identity and `pnpm migrate:list`. Back up and verify a restore. Schedule the operation when writes can tolerate the table locks; conversion can rewrite tables and indexes. A 10-second lock timeout fails safely instead of waiting indefinitely.
2. Run the opt-in migration/auth integration checks on disposable databases: `$env:COMS_RUN_DB_TESTS='1'; pnpm exec vitest run test/timestamptz-migration.spec.ts test/auth-database.spec.ts`.
3. Set the verified legacy zone if needed and apply `pnpm migrate:up` when this is the sole next migration, or review every pending migration before `pnpm migrate:latest`.
4. Run `pnpm generate:schema`, format the generated file, inspect its diff and verify the schema query below returns no rows. Verify token expiry/rotation and operations across the Manila day boundary.
5. Deploy API input validation; current app arrival forms already submit explicit UTC instants. External API clients must also include an offset on `receive_by`.

```sql
SELECT table_schema, table_name, column_name
FROM information_schema.columns
WHERE table_schema IN ('auth', 'public')
  AND data_type = 'timestamp without time zone';
```

Kysely applies the migration in a transaction. It preserves values, precision, nulls, defaults and indexes. Down converts only these 12 columns back using the same legacy zone; use the same override for up and down. Rollback drops timezone semantics for subsequent writes, so retaining the compatible timestamptz schema on application-code rollback is preferable.

## Verification

Tests exercise a populated upgrade, invalid-zone atomic failure, up/down/up preservation, microseconds, indexes/defaults/nullability, explicit offsets, UTC/Manila/Los Angeles sessions, fresh authentication migrations and a schema-wide guard against future timezone-less columns. Date-only fields retain their types. No production migration is performed by these tests.


## Local verification - 2026-10-20

- Applied to verified loopback development `coms-db`: 31 applied migrations, none pending; 86 `timestamptz` columns (17 auth, 69 public), zero timezone-less datetime columns and six date-only columns.
- Restored the pre-migration custom-format backup into a disposable database, migrated it and compared normalized data hashes for all 58 application tables. Repeated that preservation comparison against local development after migration; all matched. Backup stays outside repositories and the Obsidian vault.
- 31 focused migration/auth/DTO tests and 191 default API tests passed (47 opt-in cases skipped in the default run). 47 dispatch/receiving/reporting/sales integration cases passed serially on a disposable database; test instrumentation emitted ObserveAgentWorker restart messages without failing the suites. All disposable databases were removed.
- API typecheck, lint and build passed. Regenerated Kysely declarations from all 58 tables; no semantic diff because the generated Timestamp alias already covers timestamptz. The frontend required no code changes; 14 arrival/form tests passed under America/Los_Angeles and services on 3005/3006 returned HTTP 200.
- No production database migration or deployment. For other installations, complete the historical-zone audit and backup verification above before applying.

References: [PostgreSQL date/time types](https://www.postgresql.org/docs/current/datatype-datetime.html), [node-postgres date/time handling](https://node-postgres.com/features/types).
