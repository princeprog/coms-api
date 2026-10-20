import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE notification_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    kind text NOT NULL CHECK (kind IN ('DISPATCH_SENT', 'DISPATCH_DISCREPANCY', 'DISPATCH_RESOLVED', 'REPORT_SUBMITTED', 'REPORT_RETURNED', 'REPORT_APPROVED')),
    branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    dispatch_id uuid REFERENCES dispatches(id) ON DELETE CASCADE,
    report_id uuid REFERENCES daily_branch_reports(id) ON DELETE CASCADE,
    dispatch_event_id uuid UNIQUE REFERENCES dispatch_events(id) ON DELETE CASCADE,
    discrepancy_event_id uuid UNIQUE REFERENCES dispatch_discrepancy_events(id) ON DELETE CASCADE,
    report_event_id uuid UNIQUE REFERENCES daily_branch_report_events(id) ON DELETE CASCADE,
    actor_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (num_nonnulls(dispatch_event_id, discrepancy_event_id, report_event_id) = 1),
    CHECK ((kind LIKE 'DISPATCH_%' AND dispatch_id IS NOT NULL AND report_id IS NULL AND report_event_id IS NULL)
      OR (kind LIKE 'REPORT_%' AND report_id IS NOT NULL AND dispatch_id IS NULL AND report_event_id IS NOT NULL))
  )`.execute(db);
  await sql`CREATE TABLE notification_recipients (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id uuid NOT NULL REFERENCES notification_events(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    read_at timestamptz,
    UNIQUE (event_id, user_id)
  )`.execute(db);
  await sql`CREATE INDEX notification_inbox_idx ON notification_recipients(user_id, created_at DESC, id DESC)`.execute(
    db,
  );
  await sql`CREATE INDEX notification_unread_idx ON notification_recipients(user_id, event_id) WHERE read_at IS NULL`.execute(
    db,
  );
  await sql`CREATE INDEX notification_branch_idx ON notification_events(branch_id)`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('notification_recipients').execute();
  await db.schema.dropTable('notification_events').execute();
}
