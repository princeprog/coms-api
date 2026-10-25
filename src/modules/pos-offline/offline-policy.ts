import { createHash } from 'node:crypto';
import type { OfflineEnvelopeDto } from './dto/offline-register.dto';

// Explicit order makes semantically identical JSON independent of object key order.
export function offlineFingerprint(input: OfflineEnvelopeDto) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        input.id,
        input.session_id,
        input.device_id,
        input.shift_id,
        input.sequence,
        input.snapshot_id,
        input.captured_at,
        input.service_type,
        input.items
          .map((i) => [
            i.product_id,
            i.quantity,
            i.unit_price,
            i.price_revision,
          ])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
        input.cash_tendered,
        input.total_amount,
      ]),
    )
    .digest('hex');
}

export function offlineTimeProblem(input: {
  capturedAt: string;
  issuedAt: Date;
  cutoffAt: Date;
  snapshotAt: Date;
  lastCapturedAt: Date | null;
  now: Date;
}) {
  const captured = new Date(input.capturedAt).getTime();
  if (
    !Number.isFinite(captured) ||
    captured < input.issuedAt.getTime() ||
    captured < input.snapshotAt.getTime() ||
    captured >= input.cutoffAt.getTime() ||
    captured > input.now.getTime() + 30000
  )
    return 'The recorded sale time is outside the prepared register window.';
  if (input.lastCapturedAt && captured < input.lastCapturedAt.getTime())
    return 'The device clock moved backwards. Review the sale time.';
  return null;
}
