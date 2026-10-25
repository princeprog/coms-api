import { ConflictException } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import type { DB } from '../../database/db';

/** Requires the branch row FOR UPDATE and report lock, excluding offline writers. */
export async function requireFinalizedOfflineSessions(
  transaction: Transaction<DB>,
  branchId: string,
  businessDate: string,
) {
  const { rows } = await sql<{ id: string }>`
    SELECT session.id
    FROM pos_offline_sessions AS session
    WHERE session.branch_id = ${branchId}::uuid
      AND session.business_date = ${businessDate}::date
      AND (session.status <> 'FINALIZED' OR EXISTS (
        SELECT 1 FROM pos_offline_transactions AS pending
        WHERE pending.session_id = session.id
          AND pending.status <> 'ACKNOWLEDGED'
      ))
    LIMIT 1
  `.execute(transaction);
  if (rows.length)
    throw new ConflictException({
      code: 'OFFLINE_SYNC_REQUIRED',
      message:
        'Sync and finalize all offline register sessions for this business date before submitting or approving the report.',
    });
}
