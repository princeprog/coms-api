import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../database/db';
import { currentAuditActor } from '../../common/utils/audit-context';

export type AuditEventInput = {
  /** Defaults to the user making the current request. */
  actorUserId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  entityLabel?: string | null;
  branchId?: string | null;
  changes?: Record<string, { from: unknown; to: unknown }>;
  metadata?: Record<string, unknown>;
};

// Write inside the caller's transaction so a failed change leaves no event.
export async function recordAudit(
  executor: Kysely<DB> | Transaction<DB>,
  event: AuditEventInput,
) {
  const actor =
    event.actorUserId === undefined
      ? (currentAuditActor() ?? null)
      : event.actorUserId;
  await sql`
    INSERT INTO audit_events (
      actor_user_id, actor_name, action, entity_type, entity_id, entity_label,
      branch_id, changes, metadata
    ) VALUES (
      ${actor}::uuid,
      (SELECT full_name FROM auth.users WHERE id = ${actor}::uuid),
      ${event.action}, ${event.entityType}, ${event.entityId ?? null},
      ${event.entityLabel ?? null}, ${event.branchId ?? null}::uuid,
      ${JSON.stringify(event.changes ?? {})}::jsonb,
      ${JSON.stringify(event.metadata ?? {})}::jsonb
    )
  `.execute(executor);
}

export function listDiff(before: string[], after: string[]) {
  const previous = new Set(before);
  const next = new Set(after);
  return {
    added: after.filter((item) => !previous.has(item)).sort(),
    removed: before.filter((item) => !next.has(item)).sort(),
  };
}
