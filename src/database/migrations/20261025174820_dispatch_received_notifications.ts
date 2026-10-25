import { sql, type Kysely } from 'kysely';

const kinds =
  "'DISPATCH_SENT','DISPATCH_DISCREPANCY','DISPATCH_RESOLVED','REPORT_SUBMITTED','REPORT_RETURNED','REPORT_APPROVED','DISPATCH_OVERDUE','DISPATCH_LATE_COUNT','SHIFT_NEEDS_REVIEW','DISPATCH_COUNT_REMINDER'";

// A clean branch count tells the sending commissary team the delivery arrived.
// The notification points at the RECEIPT_RECORDED dispatch event, so retries
// never notify twice.
async function constraints(db: Kysely<any>, received: boolean) {
  const kindList = kinds + (received ? ", 'DISPATCH_RECEIVED'" : '');
  const dispatchKinds =
    "'DISPATCH_SENT','DISPATCH_DISCREPANCY','DISPATCH_RESOLVED','DISPATCH_COUNT_REMINDER'" +
    (received ? ", 'DISPATCH_RECEIVED'" : '');
  await sql`ALTER TABLE notification_events DROP CONSTRAINT notification_kind_check, DROP CONSTRAINT notification_target_check;
    ALTER TABLE notification_events ADD CONSTRAINT notification_kind_check CHECK (kind IN (${sql.raw(kindList)}));
    ALTER TABLE notification_events ADD CONSTRAINT notification_target_check CHECK (
      (kind = 'DISPATCH_OVERDUE' AND dispatch_id IS NULL AND report_id IS NULL AND receiving_source_id IS NOT NULL)
      OR (kind = 'DISPATCH_LATE_COUNT' AND dispatch_id IS NOT NULL AND report_id IS NULL AND receiving_source_id IS NOT NULL)
      OR (kind IN (${sql.raw(dispatchKinds)}) AND dispatch_id IS NOT NULL AND report_id IS NULL AND receiving_source_id IS NULL AND report_event_id IS NULL)
      OR (kind LIKE 'REPORT_%' AND report_id IS NOT NULL AND dispatch_id IS NULL AND report_event_id IS NOT NULL)
      OR (kind = 'SHIFT_NEEDS_REVIEW' AND shift_id IS NOT NULL AND dispatch_id IS NULL AND report_id IS NULL));`.execute(
    db,
  );
}

// `any` is required here since migrations should be frozen in time.
export async function up(db: Kysely<any>): Promise<void> {
  await constraints(db, true);
}

// Removes delivered-notification history so the old constraint can return.
export async function down(db: Kysely<any>): Promise<void> {
  await sql`DELETE FROM notification_events WHERE kind = 'DISPATCH_RECEIVED'`.execute(
    db,
  );
  await constraints(db, false);
}
