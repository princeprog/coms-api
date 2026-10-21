import { AsyncLocalStorage } from 'node:async_hooks';

// Who is making the current request; read when a database connection is
// reserved so audit triggers can attribute changes.
const storage = new AsyncLocalStorage<{ actorUserId?: string }>();

export function runWithAuditActor<T>(
  actorUserId: string | undefined,
  work: () => T,
): T {
  return storage.run({ actorUserId }, work);
}

export function currentAuditActor(): string | undefined {
  return storage.getStore()?.actorUserId;
}
