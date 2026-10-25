import {
  ConflictException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import { DATABASE } from '../../database/database.module';
import type { DB, Json } from '../../database/db';
import { recordAudit } from '../audit/audit-recorder';
import { NotificationWriterRepository } from '../notifications/notification-writer.repository';
import {
  createOfflineSnapshot,
  publicOfflineSnapshot,
} from './offline-snapshots';
import { postOfflineSale, type OfflineSnapshot } from './offline-sale-writer';
import { offlineFingerprint, offlineTimeProblem } from './offline-policy';
import type {
  OfflineEnvelopeDto,
  OfflinePageDto,
  UpdateDeviceDto,
} from './dto/offline-register.dto';

type Tx = Transaction<DB>;
type Session = Selectable<DB['pos_offline_sessions']>;
const json = (value: unknown) => JSON.stringify(value) as unknown as Json;
function syncRequired() {
  return new ConflictException({
    code: 'OFFLINE_SYNC_REQUIRED',
    message:
      'Synchronize all offline sales and finish this register session first.',
  });
}

@Injectable()
export class PosOfflineRepository {
  constructor(
    @Inject(DATABASE) private readonly db: Kysely<DB>,
    private readonly notifications: NotificationWriterRepository,
  ) {}

  async register(
    branchId: string,
    userId: string,
    deviceId: string,
    name: string,
  ) {
    return this.db.transaction().execute(async (tx) => {
      const inserted = await tx
        .insertInto('pos_offline_devices')
        .values({
          id: deviceId,
          branch_id: branchId,
          requested_by: userId,
          name: name.trim(),
        })
        .onConflict((c) => c.column('id').doNothing())
        .returning('id')
        .executeTakeFirst();
      const device = await tx
        .selectFrom('pos_offline_devices')
        .selectAll()
        .where('id', '=', deviceId)
        .executeTakeFirstOrThrow();
      if (device.branch_id !== branchId)
        throw new ConflictException(
          'This browser is registered to another branch.',
        );
      // Only a new request asks managers to act; repeated requests stay quiet.
      if (inserted)
        await this.notifications.publish(tx, {
          kind: 'REGISTER_DEVICE_REQUESTED',
          branch_id: branchId,
          actor_user_id: userId,
          register_device_id: deviceId,
        });
      return device;
    });
  }
  async device(branchId: string, id: string) {
    const device = await this.db
      .selectFrom('pos_offline_devices')
      .select(['id', 'name', 'status'])
      .where('branch_id', '=', branchId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!device) throw new NotFoundException('Register device not found');
    return device;
  }
  devices(branchId: string) {
    return this.db
      .selectFrom('pos_offline_devices')
      .selectAll()
      .where('branch_id', '=', branchId)
      .orderBy('created_at', 'desc')
      .execute();
  }
  async updateDevice(
    branchId: string,
    userId: string,
    id: string,
    input: UpdateDeviceDto,
  ) {
    return this.db.transaction().execute(async (tx) => {
      const previous = await tx
        .selectFrom('pos_offline_devices')
        .select('status')
        .where('branch_id', '=', branchId)
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!previous) throw new NotFoundException('Register device not found');
      const device = await tx
        .updateTable('pos_offline_devices')
        .set({
          ...(input.name ? { name: input.name.trim() } : {}),
          ...(input.status
            ? {
                status: input.status,
                approved_by: input.status === 'APPROVED' ? userId : null,
              }
            : {}),
          updated_at: sql<Date>`now()`,
        })
        .where('branch_id', '=', branchId)
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirst();
      if (!device) throw new NotFoundException('Register device not found');
      await recordAudit(tx, {
        actorUserId: userId,
        action: 'pos_offline.device_updated',
        entityType: 'pos_offline_device',
        entityId: id,
        branchId,
        metadata: { status: device.status, name: device.name },
      });
      if (input.status && input.status !== previous.status)
        await this.notifications.publish(
          tx,
          {
            kind:
              input.status === 'APPROVED'
                ? 'REGISTER_DEVICE_APPROVED'
                : 'REGISTER_DEVICE_REVOKED',
            branch_id: branchId,
            actor_user_id: userId,
            register_device_id: id,
          },
          { recipientUserIds: [device.requested_by] },
        );
      return device;
    });
  }
  async prepare(branchId: string, userId: string, deviceId: string) {
    return this.db.transaction().execute(async (tx) => {
      await this.lockBranch(tx, branchId);
      const shift = await tx
        .selectFrom('register_shifts')
        .selectAll()
        .select(sql<Date>`coms_business_day_end(business_date)`.as('cutoff_at'))
        .where('branch_id', '=', branchId)
        .where('status', '=', 'OPEN')
        .forUpdate()
        .executeTakeFirst();
      if (!shift || shift.opened_by_user_id !== userId)
        throw new ConflictException(
          'Open your own shift online before preparing this register.',
        );
      const now = new Date();
      if (shift.cutoff_at <= now)
        throw new ConflictException(
          'This business day has ended. Close the shift online.',
        );
      const report = await tx
        .selectFrom('daily_branch_reports')
        .select('id')
        .where('branch_id', '=', branchId)
        .where('business_date', '=', shift.business_date)
        .where('status', 'in', ['SUBMITTED', 'APPROVED'])
        .executeTakeFirst();
      if (report)
        throw new ConflictException(
          'The daily report is submitted or approved. This register cannot prepare another session.',
        );
      const device = await tx
        .selectFrom('pos_offline_devices')
        .selectAll()
        .where('id', '=', deviceId)
        .where('branch_id', '=', branchId)
        .forShare()
        .executeTakeFirst();
      if (device?.status !== 'APPROVED')
        throw new ConflictException(
          'A manager must approve this branch device first.',
        );
      const existing = await tx
        .selectFrom('pos_offline_sessions')
        .selectAll()
        .where('shift_id', '=', shift.id)
        .where('status', '=', 'OPEN')
        .forUpdate()
        .executeTakeFirst();
      if (existing) {
        if (existing.device_id !== deviceId || existing.cashier_id !== userId)
          throw new ConflictException(
            'This shift is prepared on another device. Synchronize and finish it there first.',
          );
        const snapshot = await tx
          .selectFrom('pos_offline_snapshots')
          .selectAll()
          .where('session_id', '=', existing.id)
          .orderBy('created_at', 'desc')
          .orderBy('id')
          .executeTakeFirstOrThrow();
        return {
          session: await this.sessionResponse(tx, existing),
          snapshot: publicOfflineSnapshot(
            snapshot.id,
            snapshot.payload as unknown as OfflineSnapshot,
          ),
        };
      }
      const occupied = await tx
        .selectFrom('pos_offline_sessions')
        .select('id')
        .where('device_id', '=', deviceId)
        .where('status', '=', 'OPEN')
        .executeTakeFirst();
      if (occupied)
        throw new ConflictException(
          'Finish the previous register session on this device first.',
        );
      const session = await tx
        .insertInto('pos_offline_sessions')
        .values({
          branch_id: branchId,
          shift_id: shift.id,
          cashier_id: userId,
          device_id: deviceId,
          business_date: shift.business_date,
          cutoff_at: shift.cutoff_at,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      const snapshot = await createOfflineSnapshot(tx, session.id, branchId);
      await recordAudit(tx, {
        actorUserId: userId,
        action: 'pos_offline.prepared',
        entityType: 'pos_offline_session',
        entityId: session.id,
        branchId,
        metadata: { device_id: deviceId, shift_id: shift.id },
      });
      return { session: await this.sessionResponse(tx, session), snapshot };
    });
  }
  async refresh(
    branchId: string,
    userId: string,
    sessionId: string,
    deviceId: string,
  ) {
    return this.db.transaction().execute(async (tx) => {
      const { session, shift, device } = await this.lockSession(
        tx,
        branchId,
        sessionId,
      );
      this.requireOwner(session, userId, deviceId);
      if (
        session.status !== 'OPEN' ||
        shift.status !== 'OPEN' ||
        device.status !== 'APPROVED' ||
        session.cutoff_at <= new Date()
      )
        throw new ConflictException(
          'This register cannot download a new menu. Synchronize its saved sales first.',
        );
      return {
        session: await this.sessionResponse(tx, session),
        snapshot: await createOfflineSnapshot(tx, session.id, branchId),
      };
    });
  }
  async ingest(
    branchId: string,
    userId: string,
    sessionId: string,
    deviceId: string,
    envelope: OfflineEnvelopeDto,
    recoveryReason?: string,
  ) {
    return this.db.transaction().execute(async (tx) => {
      const { session, shift, device } = await this.lockSession(
        tx,
        branchId,
        sessionId,
      );
      if (!recoveryReason) this.requireOwner(session, userId, deviceId);
      if (
        deviceId !== session.device_id ||
        envelope.session_id !== session.id ||
        envelope.device_id !== session.device_id ||
        envelope.shift_id !== session.shift_id
      )
        throw new ConflictException(
          'The sale belongs to a different register session.',
        );
      const fingerprint = offlineFingerprint(envelope);
      const existing = await tx
        .selectFrom('pos_offline_transactions')
        .selectAll()
        .where('id', '=', envelope.id)
        .executeTakeFirst();
      if (existing) {
        if (
          existing.session_id !== sessionId ||
          existing.fingerprint !== fingerprint
        )
          throw new ConflictException(
            'This transaction identifier already contains a different sale.',
          );
        return this.ack(tx, existing);
      }
      if (session.status !== 'OPEN')
        throw new ConflictException(
          'This offline register session is already finished.',
        );
      if (envelope.sequence !== session.last_sequence + 1)
        throw new ConflictException(
          'Upload saved sales in order without missing a sequence.',
        );
      const snapshot = await tx
        .selectFrom('pos_offline_snapshots')
        .selectAll()
        .where('id', '=', envelope.snapshot_id)
        .where('session_id', '=', session.id)
        .executeTakeFirst();
      if (!snapshot)
        throw new ConflictException(
          'The saved menu does not belong to this register session.',
        );
      const timeProblem = offlineTimeProblem({
        capturedAt: envelope.captured_at,
        issuedAt: session.issued_at,
        cutoffAt: session.cutoff_at,
        snapshotAt: snapshot.created_at,
        lastCapturedAt: session.last_captured_at,
        now: new Date(),
      });
      let problem = timeProblem;
      if (shift.status !== 'OPEN')
        problem = 'The original shift is no longer open.';
      if (device.status !== 'APPROVED' && !recoveryReason)
        problem =
          'This device was revoked. A manager must review its saved sales.';
      if (await this.reportBlocks(tx, session))
        problem = 'The original daily report is already submitted or approved.';
      let sale: { id: string; sale_reference: string } | undefined;
      if (!problem) {
        await sql`SAVEPOINT offline_post`.execute(tx);
        try {
          sale = await postOfflineSale(
            tx,
            session,
            snapshot.payload as unknown as OfflineSnapshot,
            envelope,
          );
        } catch (error) {
          await sql`ROLLBACK TO SAVEPOINT offline_post`.execute(tx);
          if (!(error instanceof HttpException)) throw error;
          problem = error.message;
        }
        await sql`RELEASE SAVEPOINT offline_post`.execute(tx);
      }
      const saved = await tx
        .insertInto('pos_offline_transactions')
        .values({
          id: envelope.id,
          session_id: session.id,
          sequence: envelope.sequence,
          snapshot_id: envelope.snapshot_id,
          payload: json(envelope),
          fingerprint,
          status: sale ? 'ACKNOWLEDGED' : 'NEEDS_REVIEW',
          reason: problem,
          sale_id: sale?.id ?? null,
          ...(recoveryReason
            ? {
                reviewed_by: userId,
                reviewed_at: sql<Date>`now()`,
                review_reason: recoveryReason,
              }
            : {}),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      const captured = new Date(envelope.captured_at);
      await tx
        .updateTable('pos_offline_sessions')
        .set({
          last_sequence: envelope.sequence,
          ...(!timeProblem &&
          Number.isFinite(captured.getTime()) &&
          (!session.last_captured_at || captured > session.last_captured_at)
            ? { last_captured_at: captured }
            : {}),
        })
        .where('id', '=', session.id)
        .execute();
      await recordAudit(tx, {
        actorUserId: userId,
        action: sale ? 'pos_offline.sale_synced' : 'pos_offline.sale_held',
        entityType: 'pos_offline_transaction',
        entityId: saved.id,
        branchId,
        metadata: {
          session_id: session.id,
          cashier_id: session.cashier_id,
          snapshot_id: envelope.snapshot_id,
          sale_id: sale?.id ?? null,
          reason: problem,
        },
      });
      return this.ack(tx, saved);
    });
  }
  async finalize(
    branchId: string,
    userId: string,
    sessionId: string,
    deviceId: string,
    finalSequence: number,
    recovery?: { transactionIds: string[]; reason: string },
  ) {
    return this.db.transaction().execute(async (tx) => {
      const { session } = await this.lockSession(tx, branchId, sessionId);
      if (!recovery) this.requireOwner(session, userId, deviceId);
      if (session.device_id !== deviceId)
        throw new ForbiddenException(
          'The device does not match this register session.',
        );
      if (session.status === 'FINALIZED') {
        if (session.final_sequence !== finalSequence) throw syncRequired();
        return { status: 'FINALIZED' as const };
      }
      const rows = await tx
        .selectFrom('pos_offline_transactions')
        .select(['id', 'sequence', 'status'])
        .where('session_id', '=', sessionId)
        .orderBy('sequence')
        .execute();
      if (
        recovery &&
        (finalSequence === 0 ||
          recovery.transactionIds.length !== rows.length ||
          rows.some((row, index) => row.id !== recovery.transactionIds[index]))
      )
        throw new ConflictException(
          'Import the complete original-device recovery export before finishing this session.',
        );
      if (
        finalSequence !== session.last_sequence ||
        rows.length !== finalSequence ||
        rows.some(
          (row, index) =>
            row.sequence !== index + 1 || row.status !== 'ACKNOWLEDGED',
        )
      )
        throw syncRequired();
      await tx
        .updateTable('pos_offline_sessions')
        .set({
          status: 'FINALIZED',
          final_sequence: finalSequence,
          finalized_at: sql<Date>`now()`,
        })
        .where('id', '=', sessionId)
        .execute();
      await recordAudit(tx, {
        actorUserId: userId,
        action: 'pos_offline.finalized',
        entityType: 'pos_offline_session',
        entityId: sessionId,
        branchId,
        metadata: {
          final_sequence: finalSequence,
          recovery: Boolean(recovery),
          ...(recovery ? { reason: recovery.reason } : {}),
        },
      });
      return { status: 'FINALIZED' as const };
    });
  }
  async review(
    branchId: string,
    userId: string,
    sessionId: string,
    transactionId: string,
    reason: string,
  ) {
    return this.db.transaction().execute(async (tx) => {
      const { session, shift } = await this.lockSession(
        tx,
        branchId,
        sessionId,
      );
      const row = await tx
        .selectFrom('pos_offline_transactions')
        .selectAll()
        .where('session_id', '=', sessionId)
        .where('id', '=', transactionId)
        .forUpdate()
        .executeTakeFirst();
      if (!row) throw new NotFoundException('Offline sale not found');
      if (row.status === 'ACKNOWLEDGED') return this.ack(tx, row);
      if (
        session.status !== 'OPEN' ||
        shift.status !== 'OPEN' ||
        (await this.reportBlocks(tx, session))
      )
        throw syncRequired();
      const snapshot = await tx
        .selectFrom('pos_offline_snapshots')
        .selectAll()
        .where('id', '=', row.snapshot_id)
        .executeTakeFirstOrThrow();
      const envelope = row.payload as unknown as OfflineEnvelopeDto;
      const problem = offlineTimeProblem({
        capturedAt: envelope.captured_at,
        issuedAt: session.issued_at,
        cutoffAt: session.cutoff_at,
        snapshotAt: snapshot.created_at,
        // A reviewer can attest to out-of-order capture within the original
        // window, but cannot change the immutable recorded time or its bounds.
        lastCapturedAt: null,
        now: new Date(),
      });
      if (problem) throw new ConflictException(problem);
      const sale = await postOfflineSale(
        tx,
        session,
        snapshot.payload as unknown as OfflineSnapshot,
        envelope,
      );
      const saved = await tx
        .updateTable('pos_offline_transactions')
        .set({
          status: 'ACKNOWLEDGED',
          sale_id: sale.id,
          reviewed_by: userId,
          reviewed_at: sql<Date>`now()`,
          review_reason: reason,
          reason: null,
        })
        .where('id', '=', row.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await recordAudit(tx, {
        actorUserId: userId,
        action: 'pos_offline.sale_recovered',
        entityType: 'pos_offline_transaction',
        entityId: row.id,
        branchId,
        metadata: { reason, cashier_id: session.cashier_id, sale_id: sale.id },
      });
      return this.ack(tx, saved);
    });
  }
  async sessions(branchId: string, query: OfflinePageDto) {
    const items = await this.db
      .selectFrom('pos_offline_sessions as s')
      .innerJoin('pos_offline_devices as d', 'd.id', 's.device_id')
      .innerJoin('coms_auth.users as u', 'u.id', 's.cashier_id')
      .selectAll('s')
      .select([
        'd.name as device_name',
        'u.full_name as cashier_name',
        sql<number>`(SELECT count(*)::int FROM pos_offline_transactions t WHERE t.session_id=s.id AND t.status='NEEDS_REVIEW')`.as(
          'review_count',
        ),
        sql<Date | null>`(SELECT max(received_at) FROM pos_offline_transactions t WHERE t.session_id=s.id)`.as(
          'last_sync_at',
        ),
      ])
      .where('s.branch_id', '=', branchId)
      .where('s.status', '=', 'OPEN')
      .orderBy('s.issued_at')
      .orderBy('s.id')
      .limit(query.page_size)
      .offset((query.page - 1) * query.page_size)
      .execute();
    const aggregate = await this.db
      .selectFrom('pos_offline_sessions')
      .select(sql<number>`count(*)::int`.as('total'))
      .where('branch_id', '=', branchId)
      .where('status', '=', 'OPEN')
      .executeTakeFirstOrThrow();
    return {
      items,
      total: aggregate.total,
      page: query.page,
      page_size: query.page_size,
    };
  }
  async transactions(
    branchId: string,
    sessionId: string,
    query: OfflinePageDto,
  ) {
    const session = await this.db
      .selectFrom('pos_offline_sessions')
      .select('id')
      .where('id', '=', sessionId)
      .where('branch_id', '=', branchId)
      .executeTakeFirst();
    if (!session) throw new NotFoundException('Register session not found');
    const filtered = this.db
      .selectFrom('pos_offline_transactions')
      .where('session_id', '=', sessionId)
      .where('status', '=', 'NEEDS_REVIEW');
    const items = await filtered
      .selectAll()
      .orderBy('sequence')
      .limit(query.page_size)
      .offset((query.page - 1) * query.page_size)
      .execute();
    const aggregate = await filtered
      .select(sql<number>`count(*)::int`.as('total'))
      .executeTakeFirstOrThrow();
    return {
      items,
      total: aggregate.total,
      page: query.page,
      page_size: query.page_size,
    };
  }
  // The browser validates this exact contract. PostgreSQL formats the date so
  // the driver's local-midnight Date conversion cannot shift the business day.
  private async sessionResponse(tx: Tx, s: Session) {
    const clock = await sql<{ business_date: string; server_time: Date }>`
      SELECT to_char(business_date, 'YYYY-MM-DD') AS business_date,
        clock_timestamp() AS server_time
      FROM pos_offline_sessions WHERE id = ${s.id}::uuid
    `.execute(tx);
    const row = clock.rows[0]!;
    return {
      id: s.id,
      device_id: s.device_id,
      shift_id: s.shift_id,
      branch_id: s.branch_id,
      cashier_id: s.cashier_id,
      issued_at: new Date(s.issued_at).toISOString(),
      cutoff_at: new Date(s.cutoff_at).toISOString(),
      server_time: new Date(row.server_time).toISOString(),
      business_date: row.business_date,
    };
  }
  private requireOwner(session: Session, userId: string, deviceId: string) {
    if (session.cashier_id !== userId || session.device_id !== deviceId)
      throw new ForbiddenException(
        'Sign in as the cashier who prepared this device.',
      );
  }
  private async lockBranch(tx: Tx, branchId: string) {
    const branch = await tx
      .selectFrom('branches')
      .select(['id', 'status'])
      .where('id', '=', branchId)
      .forShare()
      .executeTakeFirst();
    if (!branch) throw new NotFoundException('Branch not found');
    if (branch.status !== 'active')
      throw new ConflictException('This branch is inactive.');
  }
  private async lockSession(tx: Tx, branchId: string, sessionId: string) {
    await this.lockBranch(tx, branchId);
    const found = await tx
      .selectFrom('pos_offline_sessions')
      .select(['shift_id'])
      .where('id', '=', sessionId)
      .where('branch_id', '=', branchId)
      .executeTakeFirst();
    if (!found) throw new NotFoundException('Register session not found');
    const shift = await tx
      .selectFrom('register_shifts')
      .selectAll()
      .where('id', '=', found.shift_id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const session = await tx
      .selectFrom('pos_offline_sessions')
      .selectAll()
      .where('id', '=', sessionId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const device = await tx
      .selectFrom('pos_offline_devices')
      .selectAll()
      .where('id', '=', session.device_id)
      .forShare()
      .executeTakeFirstOrThrow();
    return { session, shift, device };
  }
  private async reportBlocks(tx: Tx, session: Session) {
    return Boolean(
      await tx
        .selectFrom('daily_branch_reports')
        .select('id')
        .where('branch_id', '=', session.branch_id)
        .where('business_date', '=', session.business_date)
        .where('status', 'in', ['SUBMITTED', 'APPROVED'])
        .executeTakeFirst(),
    );
  }
  private async ack(tx: Tx, row: Selectable<DB['pos_offline_transactions']>) {
    const sale = row.sale_id
      ? await tx
          .selectFrom('sales')
          .select('sale_number')
          .where('id', '=', row.sale_id)
          .executeTakeFirstOrThrow()
      : null;
    return {
      id: row.id,
      status: row.status,
      ...(sale
        ? {
            sale_id: row.sale_id,
            sale_reference: `S-${String(sale.sale_number).padStart(6, '0')}`,
          }
        : { reason: row.reason ?? 'Needs manager review.' }),
    };
  }
}
