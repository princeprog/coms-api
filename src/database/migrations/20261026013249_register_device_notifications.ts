import { sql, type Kysely } from 'kysely';

const kinds =
  "'DISPATCH_SENT','DISPATCH_DISCREPANCY','DISPATCH_RESOLVED','REPORT_SUBMITTED','REPORT_RETURNED','REPORT_APPROVED','DISPATCH_OVERDUE','DISPATCH_LATE_COUNT','SHIFT_NEEDS_REVIEW','DISPATCH_COUNT_REMINDER','DISPATCH_RECEIVED'";
const deviceKinds =
  "'REGISTER_DEVICE_REQUESTED','REGISTER_DEVICE_APPROVED','REGISTER_DEVICE_REVOKED'";

// Register approval requests and decisions point at the device they concern.
async function constraints(db: Kysely<any>, devices: boolean) {
  const kindList = kinds + (devices ? `, ${deviceKinds}` : '');
  const deviceTarget = devices
    ? sql`OR (kind LIKE 'REGISTER_DEVICE_%' AND register_device_id IS NOT NULL AND dispatch_id IS NULL AND report_id IS NULL AND shift_id IS NULL AND receiving_source_id IS NULL)`
    : sql``;
  const sources = devices
    ? 'dispatch_event_id, discrepancy_event_id, report_event_id, receiving_source_id, shift_id, register_device_id'
    : 'dispatch_event_id, discrepancy_event_id, report_event_id, receiving_source_id, shift_id';
  await sql`ALTER TABLE notification_events DROP CONSTRAINT notification_kind_check, DROP CONSTRAINT notification_target_check, DROP CONSTRAINT notification_source_check;
    ALTER TABLE notification_events ADD CONSTRAINT notification_kind_check CHECK (kind IN (${sql.raw(kindList)}));
    ALTER TABLE notification_events ADD CONSTRAINT notification_source_check CHECK (num_nonnulls(${sql.raw(sources)}) = 1);
    ALTER TABLE notification_events ADD CONSTRAINT notification_target_check CHECK (
      (kind = 'DISPATCH_OVERDUE' AND dispatch_id IS NULL AND report_id IS NULL AND receiving_source_id IS NOT NULL)
      OR (kind = 'DISPATCH_LATE_COUNT' AND dispatch_id IS NOT NULL AND report_id IS NULL AND receiving_source_id IS NOT NULL)
      OR (kind IN ('DISPATCH_SENT','DISPATCH_DISCREPANCY','DISPATCH_RESOLVED','DISPATCH_COUNT_REMINDER','DISPATCH_RECEIVED') AND dispatch_id IS NOT NULL AND report_id IS NULL AND receiving_source_id IS NULL AND report_event_id IS NULL)
      OR (kind LIKE 'REPORT_%' AND report_id IS NOT NULL AND dispatch_id IS NULL AND report_event_id IS NOT NULL)
      OR (kind = 'SHIFT_NEEDS_REVIEW' AND shift_id IS NOT NULL AND dispatch_id IS NULL AND report_id IS NULL)
      ${deviceTarget});`.execute(db);
}

// `any` is required here since migrations should be frozen in time.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE notification_events
      ADD COLUMN register_device_id uuid REFERENCES pos_offline_devices(id);
    CREATE INDEX notification_events_register_device ON notification_events (register_device_id)
      WHERE register_device_id IS NOT NULL;`.execute(db);
  await constraints(db, true);
}

// Removes register notification history so the previous constraints can return.
export async function down(db: Kysely<any>): Promise<void> {
  await sql`DELETE FROM notification_events WHERE kind LIKE 'REGISTER_DEVICE_%'`.execute(
    db,
  );
  await constraints(db, false);
  await sql`ALTER TABLE notification_events DROP COLUMN register_device_id`.execute(
    db,
  );
}
