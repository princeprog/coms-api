# Empty Supabase initialization

The user chose an empty production database and explicitly approved preserving
only the existing active local Super Admin account and its password.

The Sydney Supabase target was confirmed to have zero public tables and no
`coms_auth` schema. Its public schema was backed up outside the repositories and
the Obsidian vault. A new disposable local database ran all 43 Kysely migrations;
its resulting `public` and `coms_auth` schemas and default seed rows were dumped
without owners or privileges. No operational local data was included.

The backup was restored in a second disposable database, then the baseline was
rehearsed with a sentinel in a separate reserved `auth` schema. All 43 migration
records were present, accounts were empty, and the sentinel survived.

The Supabase restore and Data API restrictions ran in a single transaction.
RLS is enabled on every COMS table; `PUBLIC`, `anon`, and `authenticated` have
no COMS table/sequence privileges or access to the private `coms_auth` schema.
COMS functions are not executable by these roles. Default privileges prevent
future tables from automatically granting Data API access. The Nest API remains
the permission and branch-scoping boundary for application users.

Verified after restore: 43 migration records, no branches or sales, all COMS
tables have RLS, and Supabase's 27 reserved `auth` tables remain present. Then
one existing active Super Admin was copied with its original password hash and
mapped to the new system role. No sessions, other accounts, branch assignments,
inventory, dispatches, reports or sales were copied. Direct Data API table
access for both `anon` and `authenticated` was verified absent.

Backup and baseline files are under `Documents/COMS Backups/` and are not
committed. Never replay the historical `auth` migrations directly on Supabase.
Subsequent schema changes must use new forward migrations.
