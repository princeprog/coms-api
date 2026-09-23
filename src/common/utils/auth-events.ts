import { Logger } from '@nestjs/common';

const logger = new Logger('AuthEvents');
const counts = new Map<string, number>();

// Fixed event names only: never accept request data or credentials here.
export function recordAuthEvent(
  event:
    | 'gateway_rejected'
    | 'origin_rejected'
    | 'rate_limited'
    | 'refresh_replay'
    | 'auth_outage',
  status: number,
): void {
  const key = `${event}:${status}`;
  const count = (counts.get(key) ?? 0) + 1;
  counts.set(key, count);
  logger.warn({ event, status, count });
}
