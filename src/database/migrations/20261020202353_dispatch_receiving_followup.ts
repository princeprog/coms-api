import { sql, type Kysely } from 'kysely';

// `any` is required here since migrations should be frozen in time. alternatively, keep a "snapshot" db interface.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    ALTER TABLE dispatches ADD COLUMN receive_by timestamptz;
    UPDATE dispatches SET receive_by = clock_timestamp() + interval '24 hours'
      WHERE dispatched_at IS NOT NULL AND counted_at IS NULL
        AND status IN ('IN_TRANSIT', 'PARTIALLY_RECEIVED');
    ALTER TABLE dispatch_receipts ADD COLUMN delivery_date date;
    UPDATE dispatch_receipts SET delivery_date = (created_at AT TIME ZONE 'Asia/Manila')::date;
    ALTER TABLE dispatch_receipts ALTER COLUMN delivery_date SET NOT NULL;
    ALTER TABLE dispatch_receipts ALTER COLUMN delivery_date SET DEFAULT ((now() AT TIME ZONE 'Asia/Manila')::date);
    ALTER TABLE dispatch_receipts ADD COLUMN late_reason text;
    CREATE TABLE dispatch_late_counts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      dispatch_id uuid NOT NULL REFERENCES dispatches(id) ON DELETE CASCADE,
      counted_by_user_id uuid NOT NULL REFERENCES auth.users(id),
      idempotency_key uuid NOT NULL UNIQUE,
      delivery_date date NOT NULL,
      late_reason text NOT NULL,
      note text,
      items jsonb NOT NULL CHECK (jsonb_typeof(items) = 'array'),
      status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'RETURNED', 'POSTED')),
      reviewed_by_user_id uuid REFERENCES auth.users(id),
      review_reason text,
      reviewed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp()
    );
    CREATE UNIQUE INDEX dispatch_one_pending_count ON dispatch_late_counts(dispatch_id) WHERE status = 'PENDING';
    CREATE INDEX dispatch_pending_deadline ON dispatches(branch_id, receive_by) WHERE counted_at IS NULL AND dispatched_at IS NOT NULL;
    CREATE TABLE daily_report_delivery_exceptions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      report_event_id uuid NOT NULL REFERENCES daily_branch_report_events(id) ON DELETE CASCADE,
      dispatch_id uuid NOT NULL REFERENCES dispatches(id),
      reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
      UNIQUE(report_event_id, dispatch_id)
    );
    CREATE TABLE receiving_notification_sources (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
      reminder_date date,
      late_count_id uuid UNIQUE REFERENCES dispatch_late_counts(id) ON DELETE CASCADE,
      overdue_count integer,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      CHECK (num_nonnulls(reminder_date, late_count_id) = 1),
      UNIQUE(branch_id, reminder_date)
    );
    ALTER TABLE notification_events ADD COLUMN receiving_source_id uuid UNIQUE REFERENCES receiving_notification_sources(id) ON DELETE CASCADE;
    DO $$ DECLARE c record; BEGIN
      FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'notification_events'::regclass AND contype = 'c'
      LOOP EXECUTE format('ALTER TABLE notification_events DROP CONSTRAINT %I', c.conname); END LOOP;
    END $$;
    ALTER TABLE notification_events ADD CONSTRAINT notification_kind_check CHECK (kind IN
      ('DISPATCH_SENT','DISPATCH_DISCREPANCY','DISPATCH_RESOLVED','REPORT_SUBMITTED','REPORT_RETURNED','REPORT_APPROVED','DISPATCH_OVERDUE','DISPATCH_LATE_COUNT'));
    ALTER TABLE notification_events ADD CONSTRAINT notification_source_check CHECK (num_nonnulls(dispatch_event_id, discrepancy_event_id, report_event_id, receiving_source_id) = 1);
    ALTER TABLE notification_events ADD CONSTRAINT notification_target_check CHECK (
      (kind = 'DISPATCH_OVERDUE' AND dispatch_id IS NULL AND report_id IS NULL AND receiving_source_id IS NOT NULL)
      OR (kind = 'DISPATCH_LATE_COUNT' AND dispatch_id IS NOT NULL AND report_id IS NULL AND receiving_source_id IS NOT NULL)
      OR (kind IN ('DISPATCH_SENT','DISPATCH_DISCREPANCY','DISPATCH_RESOLVED') AND dispatch_id IS NOT NULL AND report_id IS NULL AND receiving_source_id IS NULL AND report_event_id IS NULL)
      OR (kind LIKE 'REPORT_%' AND report_id IS NOT NULL AND dispatch_id IS NULL AND report_event_id IS NOT NULL)
    );
  `.execute(db);
}

// `any` is required here since migrations should be frozen in time. alternatively, keep a "snapshot" db interface.
export async function down(db: Kysely<any>): Promise<void> {
  await sql`
    DELETE FROM notification_events WHERE receiving_source_id IS NOT NULL;
    ALTER TABLE notification_events DROP CONSTRAINT notification_source_check, DROP CONSTRAINT notification_target_check, DROP CONSTRAINT notification_kind_check;
    ALTER TABLE notification_events DROP COLUMN receiving_source_id;
    ALTER TABLE notification_events ADD CHECK (num_nonnulls(dispatch_event_id, discrepancy_event_id, report_event_id) = 1);
    ALTER TABLE notification_events ADD CHECK (kind IN ('DISPATCH_SENT','DISPATCH_DISCREPANCY','DISPATCH_RESOLVED','REPORT_SUBMITTED','REPORT_RETURNED','REPORT_APPROVED'));
    ALTER TABLE notification_events ADD CHECK ((kind LIKE 'DISPATCH_%' AND dispatch_id IS NOT NULL AND report_id IS NULL AND report_event_id IS NULL) OR (kind LIKE 'REPORT_%' AND report_id IS NOT NULL AND dispatch_id IS NULL AND report_event_id IS NOT NULL));
    DROP TABLE receiving_notification_sources;
    DROP TABLE daily_report_delivery_exceptions;
    DROP TABLE dispatch_late_counts;
    DROP INDEX dispatch_pending_deadline;
    ALTER TABLE dispatch_receipts DROP COLUMN delivery_date, DROP COLUMN late_reason;
    ALTER TABLE dispatches DROP COLUMN receive_by;
  `.execute(db);
}
