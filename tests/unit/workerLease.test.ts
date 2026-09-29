import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Prisma } from '@prisma/client';

vi.mock('../../lib/db', () => ({
  prisma: {
    workerLease: { updateMany: vi.fn(), create: vi.fn() },
  },
}));

vi.mock('../../lib/sendEngine', () => ({ processDueEmails: vi.fn() }));
vi.mock('../../lib/imapService', () => ({ syncAllActiveMailboxes: vi.fn() }));

import { prisma } from '../../lib/db';
import { processDueEmails } from '../../lib/sendEngine';
import { syncAllActiveMailboxes } from '../../lib/imapService';
import {
  SEND_WORKER_LEASE,
  LEASE_TTL_MS,
  LEASE_RENEW_MS,
  LEASE_HOLDER_ID,
  acquireLease,
  recordLeaseTick,
  createLeasedTick,
} from '../../lib/workerLease';
import { startBackgroundWorker } from '../../lib/workerDaemon';

const mockedPrisma = prisma as any;

type LeaseRow = {
  name: string;
  holderId: string;
  expiresAt: Date;
  lastTickAt: Date | null;
  lastSuccessAt: Date | null;
  lastError: string | null;
};

/** The WorkerLease table the mocked Prisma calls run against. `name` is the
 * primary key, so a second row under the same name is a unique violation. */
let rows: LeaseRow[];

const T0 = new Date('2026-09-01T12:00:00Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const knownError = (code: string) =>
  new Prisma.PrismaClientKnownRequestError(`Mocked ${code}`, { code, clientVersion: 'test' });

function matches(row: any, where: Record<string, any>): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return (cond as Record<string, any>[]).some((w) => matches(row, w));
    if (cond instanceof Object && !(cond instanceof Date) && 'lte' in cond) return row[key].getTime() <= cond.lte.getTime();
    return row[key] === cond;
  });
}

function seed(row: Partial<LeaseRow> & { holderId: string; expiresAt: Date }) {
  rows.push({ name: SEND_WORKER_LEASE, lastTickAt: null, lastSuccessAt: null, lastError: null, ...row });
}

function deferred() {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  rows = [];
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mockedPrisma.workerLease.updateMany.mockImplementation(async ({ where, data }: any) => {
    const hit = rows.filter((r) => matches(r, where));
    hit.forEach((r) => Object.assign(r, data));
    return { count: hit.length };
  });
  mockedPrisma.workerLease.create.mockImplementation(async ({ data }: any) => {
    if (rows.some((r) => r.name === data.name)) throw knownError('P2002');
    const row: LeaseRow = { lastTickAt: null, lastSuccessAt: null, lastError: null, ...data };
    rows.push(row);
    return { ...row };
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('acquireLease (M8)', () => {
  it('creates the lease row when none exists', async () => {
    expect(await acquireLease(SEND_WORKER_LEASE, 'A', T0)).toBe(true);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: SEND_WORKER_LEASE, holderId: 'A', expiresAt: at(LEASE_TTL_MS) });
  });

  it('refuses while another process holds an unexpired lease', async () => {
    seed({ holderId: 'A', expiresAt: at(LEASE_TTL_MS) });

    expect(await acquireLease(SEND_WORKER_LEASE, 'B', at(LEASE_TTL_MS - 1))).toBe(false);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ holderId: 'A', expiresAt: at(LEASE_TTL_MS) });
  });

  it('renews a lease this process already holds', async () => {
    seed({ holderId: 'A', expiresAt: at(LEASE_TTL_MS) });

    expect(await acquireLease(SEND_WORKER_LEASE, 'A', at(30_000))).toBe(true);

    expect(rows[0]).toMatchObject({ holderId: 'A', expiresAt: at(30_000 + LEASE_TTL_MS) });
  });

  it('takes over an expired lease from a stopped process', async () => {
    seed({ holderId: 'A', expiresAt: at(LEASE_TTL_MS) });

    expect(await acquireLease(SEND_WORKER_LEASE, 'B', at(LEASE_TTL_MS))).toBe(true);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ holderId: 'B', expiresAt: at(2 * LEASE_TTL_MS) });
  });

  it('gives the lease to exactly one of two processes racing for an empty table', async () => {
    const [a, b] = await Promise.all([
      acquireLease(SEND_WORKER_LEASE, 'A', T0),
      acquireLease(SEND_WORKER_LEASE, 'B', T0),
    ]);

    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].holderId).toBe(a ? 'A' : 'B');
  });

  it('gives the lease to both loops of one process racing for an empty table', async () => {
    const results = await Promise.all([
      acquireLease(SEND_WORKER_LEASE, 'A', T0),
      acquireLease(SEND_WORKER_LEASE, 'A', T0),
    ]);

    expect(results).toEqual([true, true]);
    expect(rows).toHaveLength(1);
  });

  it('keeps leases with different names apart', async () => {
    seed({ holderId: 'A', expiresAt: at(LEASE_TTL_MS) });

    expect(await acquireLease('other-lease', 'B', T0)).toBe(true);
    expect(rows.map((r) => [r.name, r.holderId])).toEqual([[SEND_WORKER_LEASE, 'A'], ['other-lease', 'B']]);
  });

  it('rethrows database errors other than a unique violation', async () => {
    mockedPrisma.workerLease.create.mockRejectedValueOnce(knownError('P1001'));

    await expect(acquireLease(SEND_WORKER_LEASE, 'A', T0)).rejects.toMatchObject({ code: 'P1001' });
  });
});

describe('recordLeaseTick (M8)', () => {
  it('records a successful tick and clears the last error', async () => {
    seed({ holderId: 'A', expiresAt: at(LEASE_TTL_MS), lastError: 'old failure' });

    await recordLeaseTick(SEND_WORKER_LEASE, T0, null, 'A', at(5_000));

    expect(rows[0]).toMatchObject({ lastTickAt: T0, lastSuccessAt: at(5_000), lastError: null });
  });

  it('records a failed tick without moving the last success', async () => {
    seed({ holderId: 'A', expiresAt: at(LEASE_TTL_MS), lastSuccessAt: at(-30_000) });

    await recordLeaseTick(SEND_WORKER_LEASE, T0, 'boom', 'A', at(5_000));

    expect(rows[0]).toMatchObject({ lastTickAt: T0, lastSuccessAt: at(-30_000), lastError: 'boom' });
  });

  it('writes nothing once another process holds the lease', async () => {
    seed({ holderId: 'B', expiresAt: at(LEASE_TTL_MS) });

    await recordLeaseTick(SEND_WORKER_LEASE, T0, null, 'A', at(5_000));

    expect(rows[0]).toMatchObject({ holderId: 'B', lastTickAt: null, lastSuccessAt: null });
  });
});

describe('createLeasedTick (M8)', () => {
  it('runs the work under the lease and writes the heartbeat', async () => {
    const work = vi.fn(async () => {});
    const tick = createLeasedTick('send', work, { heartbeat: true, holderId: 'A' });

    expect(await tick()).toBe('ran');

    expect(work).toHaveBeenCalledTimes(1);
    expect(rows[0].holderId).toBe('A');
    expect(rows[0].lastTickAt).toBeInstanceOf(Date);
    expect(rows[0].lastSuccessAt).toBeInstanceOf(Date);
    expect(rows[0].lastError).toBeNull();
  });

  it('skips the work when another process holds the lease', async () => {
    seed({ holderId: 'B', expiresAt: new Date(Date.now() + LEASE_TTL_MS) });
    const work = vi.fn(async () => {});
    const tick = createLeasedTick('send', work, { heartbeat: true, holderId: 'A' });

    expect(await tick()).toBe('no-lease');

    expect(work).not.toHaveBeenCalled();
    expect(rows[0]).toMatchObject({ holderId: 'B', lastTickAt: null });
  });

  it('skips the work when the lease cannot be checked', async () => {
    mockedPrisma.workerLease.updateMany.mockRejectedValueOnce(knownError('P1001'));
    const work = vi.fn(async () => {});
    const tick = createLeasedTick('send', work, { holderId: 'A' });

    expect(await tick()).toBe('no-lease');
    expect(work).not.toHaveBeenCalled();
  });

  it('records a failing tick as an error and still resolves', async () => {
    const tick = createLeasedTick('send', async () => { throw new Error('send cycle failed'); }, { heartbeat: true, holderId: 'A' });

    expect(await tick()).toBe('ran');

    expect(rows[0]).toMatchObject({ lastSuccessAt: null, lastError: 'send cycle failed' });
    expect(rows[0].lastTickAt).toBeInstanceOf(Date);
  });

  it('writes no heartbeat for a loop that does not ask for one', async () => {
    const tick = createLeasedTick('IMAP sync', async () => {}, { holderId: 'A' });

    expect(await tick()).toBe('ran');
    expect(rows[0]).toMatchObject({ holderId: 'A', lastTickAt: null, lastSuccessAt: null });
  });

  it('skips a tick while the previous one of the same loop is still running', async () => {
    let pending = deferred();
    const work = vi.fn(() => pending.promise);
    const tick = createLeasedTick('send', work, { holderId: 'A' });

    const first = tick();
    expect(await tick()).toBe('in-flight');
    await vi.waitFor(() => expect(work).toHaveBeenCalledTimes(1));

    pending.resolve();
    expect(await first).toBe('ran');

    // Once the previous tick has finished the next one runs again.
    pending = deferred();
    const third = tick();
    await vi.waitFor(() => expect(work).toHaveBeenCalledTimes(2));
    pending.resolve();
    expect(await third).toBe('ran');
  });

  it('keeps the in-flight flag per loop', async () => {
    const pending = deferred();
    const sendTick = createLeasedTick('send', () => pending.promise, { holderId: 'A' });
    const imapWork = vi.fn(async () => {});
    const imapTick = createLeasedTick('IMAP sync', imapWork, { holderId: 'A' });

    const running = sendTick();
    expect(await imapTick()).toBe('ran');
    expect(imapWork).toHaveBeenCalledTimes(1);

    pending.resolve();
    expect(await running).toBe('ran');
  });

  it('renews the lease while a long tick runs, and stops renewing when it ends', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const pending = deferred();
    const work = vi.fn(() => pending.promise);
    const tick = createLeasedTick('send', work, { holderId: 'A' });

    const running = tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(work).toHaveBeenCalledTimes(1);

    // Well past the first expiry, the renewals keep another process out.
    await vi.advanceTimersByTimeAsync(LEASE_TTL_MS + LEASE_RENEW_MS);
    expect(await acquireLease(SEND_WORKER_LEASE, 'B')).toBe(false);
    expect(rows[0].expiresAt.getTime()).toBe(Date.now() + LEASE_TTL_MS);

    pending.resolve();
    expect(await running).toBe('ran');

    // With the tick over nothing renews, so the lease lapses and can be taken.
    await vi.advanceTimersByTimeAsync(LEASE_TTL_MS);
    expect(await acquireLease(SEND_WORKER_LEASE, 'B')).toBe(true);
  });
});

describe('startBackgroundWorker (M8)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    (globalThis as any).workerStarted = undefined;
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.unstubAllEnvs();
    (globalThis as any).workerStarted = undefined;
  });

  it.each([undefined, '', 'false', '1', 'TRUE'])('stays off when SEND_WORKER_ENABLED is %j', async (value) => {
    vi.stubEnv('SEND_WORKER_ENABLED', value);

    startBackgroundWorker();

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(processDueEmails).not.toHaveBeenCalled();
    expect(syncAllActiveMailboxes).not.toHaveBeenCalled();
    expect(mockedPrisma.workerLease.updateMany).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.log).mock.calls[0][0]).toContain('SEND_WORKER_ENABLED');
  });

  it('sends and syncs under the lease when SEND_WORKER_ENABLED is "true"', async () => {
    vi.stubEnv('SEND_WORKER_ENABLED', 'true');

    startBackgroundWorker();
    await vi.advanceTimersByTimeAsync(1000);

    expect(processDueEmails).toHaveBeenCalledTimes(1);
    expect(rows[0]).toMatchObject({ holderId: LEASE_HOLDER_ID, lastTickAt: at(1000), lastError: null });
    expect(rows[0].lastSuccessAt).toBeInstanceOf(Date);

    await vi.advanceTimersByTimeAsync(4000);
    expect(syncAllActiveMailboxes).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(processDueEmails).toHaveBeenCalledTimes(2);
  });

  it('neither sends nor syncs while another process holds the lease', async () => {
    vi.stubEnv('SEND_WORKER_ENABLED', 'true');
    seed({ holderId: 'other-process', expiresAt: at(60 * 60 * 1000) });

    startBackgroundWorker();
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

    expect(processDueEmails).not.toHaveBeenCalled();
    expect(syncAllActiveMailboxes).not.toHaveBeenCalled();
    expect(rows[0]).toMatchObject({ holderId: 'other-process', lastTickAt: null });
  });
});
