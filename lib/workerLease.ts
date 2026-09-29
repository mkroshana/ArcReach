import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from './db';

/** The one lease both worker loops (send and IMAP sync) run under. */
export const SEND_WORKER_LEASE = 'send-worker';
/** How long a lease lasts unrenewed: a stopped or crashed holder is replaced after this. */
export const LEASE_TTL_MS = 2 * 60 * 1000;
/** How often a running tick renews the lease, well inside the TTL. */
export const LEASE_RENEW_MS = 30 * 1000;

const globalForLease = globalThis as unknown as { workerLeaseHolderId: string | undefined };

/** Random id for this process; kept on globalThis so a dev module reload never competes with itself. */
export const LEASE_HOLDER_ID = (globalForLease.workerLeaseHolderId ??= randomUUID());

/**
 * Takes or renews the named lease for `holderId` with a conditional write that
 * only succeeds when the row is missing, expired, or already held by it.
 * Returns whether `holderId` now holds the lease.
 */
export async function acquireLease(name: string, holderId: string = LEASE_HOLDER_ID, now: Date = new Date()): Promise<boolean> {
  const expiresAt = new Date(now.getTime() + LEASE_TTL_MS);
  const takeOrRenew = async () => {
    const { count } = await prisma.workerLease.updateMany({
      where: { name, OR: [{ holderId }, { expiresAt: { lte: now } }] },
      data: { holderId, expiresAt },
    });
    return count > 0;
  };
  if (await takeOrRenew()) return true;

  try {
    await prisma.workerLease.create({ data: { name, holderId, expiresAt } });
    return true;
  } catch (err) {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
  }
  // Someone created the row first; that may be this process's other loop, so
  // check again rather than assume another process holds it.
  return takeOrRenew();
}

/**
 * Writes the heartbeat for a finished tick, but only while `holderId` still
 * holds the lease. `error` is null when the tick succeeded.
 */
export async function recordLeaseTick(
  name: string,
  startedAt: Date,
  error: string | null,
  holderId: string = LEASE_HOLDER_ID,
  now: Date = new Date(),
): Promise<void> {
  await prisma.workerLease.updateMany({
    where: { name, holderId },
    data: error === null
      ? { lastTickAt: startedAt, lastSuccessAt: now, lastError: null }
      : { lastTickAt: startedAt, lastError: error.slice(0, 1000) },
  });
}

export type LeasedTickResult = 'ran' | 'in-flight' | 'no-lease';

/**
 * Wraps one worker loop's tick. A call is skipped while the loop's previous
 * tick is still running in this process, or when another process holds the
 * lease. While the tick runs the lease is renewed every LEASE_RENEW_MS; with
 * `heartbeat` set, the tick's outcome is written to the lease row.
 */
export function createLeasedTick(
  label: string,
  work: () => Promise<void>,
  { heartbeat = false, name = SEND_WORKER_LEASE, holderId = LEASE_HOLDER_ID } = {},
): () => Promise<LeasedTickResult> {
  let inFlight = false;

  return async () => {
    if (inFlight) {
      console.log(`[Background Worker] Skipping ${label} tick: the previous one is still running.`);
      return 'in-flight';
    }
    inFlight = true;
    try {
      let held: boolean;
      try {
        held = await acquireLease(name, holderId);
      } catch (err) {
        console.error(`[Background Worker] Skipping ${label} tick: could not take the worker lease:`, err);
        return 'no-lease';
      }
      if (!held) {
        console.log(`[Background Worker] Skipping ${label} tick: another process holds the worker lease.`);
        return 'no-lease';
      }

      const renew = setInterval(() => {
        acquireLease(name, holderId)
          .then((still) => {
            if (!still) console.warn(`[Background Worker] Lost the worker lease during a ${label} tick.`);
          })
          .catch((err) => console.error(`[Background Worker] Could not renew the worker lease during a ${label} tick:`, err));
      }, LEASE_RENEW_MS);

      const startedAt = new Date();
      let error: string | null = null;
      try {
        await work();
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        console.error(`[Background Worker] ${label} tick error:`, err);
      } finally {
        clearInterval(renew);
      }

      if (heartbeat) {
        try {
          await recordLeaseTick(name, startedAt, error, holderId);
        } catch (err) {
          console.error(`[Background Worker] Could not record the ${label} tick heartbeat:`, err);
        }
      }
      return 'ran';
    } finally {
      inFlight = false;
    }
  };
}
