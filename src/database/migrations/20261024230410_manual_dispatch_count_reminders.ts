import { sql, type Kysely } from 'kysely';
const kinds =
  "'DISPATCH_SENT','DISPATCH_DISCREPANCY','DISPATCH_RESOLVED','REPORT_SUBMITTED','REPORT_RETURNED','REPORT_APPROVED','DISPATCH_OVERDUE','DISPATCH_LATE_COUNT','SHIFT_NEEDS_REVIEW'";
async function constraints(db: Kysely<any>, enabled: boolean) {
  await sql`ALTER TABLE dispatch_events DROP CONSTRAINT dispatch_events_type_reference_consistent;
    ALTER TABLE dispatch_events ADD CONSTRAINT dispatch_events_type_reference_consistent CHECK (
      (event_type IN ('CREATED','DISPATCHED'${sql.raw(enabled ? ", 'COUNT_REMINDER_SENT'" : '')}) AND dispatch_receipt_id IS NULL AND shortage_closure_id IS NULL)
      OR (event_type = 'RECEIPT_RECORDED' AND dispatch_receipt_id IS NOT NULL AND shortage_closure_id IS NULL)
      OR (event_type = 'SHORTAGE_CLOSED' AND dispatch_receipt_id IS NULL AND shortage_closure_id IS NOT NULL));
    ALTER TABLE notification_events DROP CONSTRAINT notification_kind_check, DROP CONSTRAINT notification_target_check;
    ALTER TABLE notification_events ADD CONSTRAINT notification_kind_check CHECK (kind IN (${sql.raw(kinds + (enabled ? ", 'DISPATCH_COUNT_REMINDER'" : ''))}));
    ALTER TABLE notification_events ADD CONSTRAINT notification_target_check CHECK (
      (kind = 'DISPATCH_OVERDUE' AND dispatch_id IS NULL AND report_id IS NULL AND receiving_source_id IS NOT NULL)
      OR (kind = 'DISPATCH_LATE_COUNT' AND dispatch_id IS NOT NULL AND report_id IS NULL AND receiving_source_id IS NOT NULL)
      OR (kind IN ('DISPATCH_SENT','DISPATCH_DISCREPANCY','DISPATCH_RESOLVED'${sql.raw(enabled ? ", 'DISPATCH_COUNT_REMINDER'" : '')}) AND dispatch_id IS NOT NULL AND report_id IS NULL AND receiving_source_id IS NULL AND report_event_id IS NULL)
      OR (kind LIKE 'REPORT_%' AND report_id IS NOT NULL AND dispatch_id IS NULL AND report_event_id IS NOT NULL)
      OR (kind = 'SHIFT_NEEDS_REVIEW' AND shift_id IS NOT NULL AND dispatch_id IS NULL AND report_id IS NULL));`.execute(
    db,
  );
}
export async function up(db: Kysely<any>): Promise<void> {
  await constraints(db, true);
  await sql`CREATE INDEX dispatch_events_count_reminder_idx ON dispatch_events (dispatch_id, created_at DESC) WHERE event_type = 'COUNT_REMINDER_SENT'`.execute(
    db,
  );
}
export async function down(db: Kysely<any>): Promise<void> {
  const existing = await db
    .selectFrom('dispatch_events')
    .select('id')
    .where('event_type', '=', 'COUNT_REMINDER_SENT')
    .limit(1)
    .executeTakeFirst();
  if (existing)
    throw new Error(
      'Keep the additive reminder schema while reminder history exists',
    );
  await sql`DROP INDEX dispatch_events_count_reminder_idx`.execute(db);
  await constraints(db, false);
}
