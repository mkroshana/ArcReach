import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../lib/db', () => ({
  db: { getAccounts: vi.fn() },
  prisma: {
    campaign: { findMany: vi.fn() },
    emailDispatch: { count: vi.fn() },
    inboundResponse: { count: vi.fn() },
    campaignEnrollment: { count: vi.fn() },
    globalSettings: { findUnique: vi.fn(), findFirst: vi.fn() },
  },
}));

vi.mock('../../lib/session', () => ({
  getSession: vi.fn(),
}));

import { db, prisma } from '../../lib/db';
import { getSession } from '../../lib/session';
import { GET as getAccounts } from '../../app/api/accounts/route';
import { GET as getCapacity } from '../../app/api/accounts/capacity/route';
import { combinedDailyCapacity, globalDailyAllowance, globalDailyCeiling, mailboxDailyLimitsOff, mailboxRemaining } from '../../lib/mailboxCapacity';

const mockedDb = db as any;
const mockedPrisma = prisma as any;

type DispatchRow = { senderAccountId: string; status: string; sentAt: Date };

const HOUR = 3600000;
// Half an hour past midnight UTC, when the old since-midnight count had just reset.
const NOW = new Date('2026-03-11T00:30:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);

let dispatches: DispatchRow[];

/** Evaluates a flat dispatch filter; throws on shapes it doesn't model so a changed query can't silently match. */
function matchesValue(value: any, cond: any): boolean {
  if (cond === null || typeof cond !== 'object') return value === cond;
  if ('in' in cond) return cond.in.includes(value);
  if ('gt' in cond) return value > cond.gt;
  if ('gte' in cond) return value >= cond.gte;
  throw new Error(`Unmodelled filter: ${JSON.stringify(cond)}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  dispatches = [];
  vi.mocked(getSession).mockResolvedValue({ id: 'admin-1', name: 'Admin', email: 'admin@example.com', role: 'ADMIN' } as any);
  mockedDb.getAccounts.mockResolvedValue([
    { id: 'mb-1', dailyLimit: 50, warmupEnabled: false, warmupStartedAt: null, warmupLimit: 10, warmupRamp: 2, imapPass: null },
  ]);
  // No settings row: no global rate limit, so each mailbox is held to its own daily limit.
  mockedPrisma.globalSettings.findUnique.mockResolvedValue(null);
  mockedPrisma.globalSettings.findFirst.mockResolvedValue(null);
  mockedPrisma.campaign.findMany.mockResolvedValue([]);
  mockedPrisma.inboundResponse.count.mockResolvedValue(0);
  mockedPrisma.campaignEnrollment.count.mockResolvedValue(0);
  // The lifetime stats filter through AND, OR and relations (events) and are not under test here.
  mockedPrisma.emailDispatch.count.mockImplementation(async ({ where }: any) => {
    if ('OR' in where || 'AND' in where) return 0;
    return dispatches.filter((d) => Object.entries(where).every(([key, cond]) => matchesValue((d as any)[key], cond))).length;
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GET /api/accounts counts sends toward the cap as the send engine does (M10, M11)', () => {
  it('reports the mailbox\'s Sending, Sent and Unknown sends over the last 24 hours, across midnight, without Failed ones', async () => {
    dispatches = [
      { senderAccountId: 'mb-1', status: 'Sent', sentAt: ago(HOUR) }, // before midnight
      { senderAccountId: 'mb-1', status: 'Sending', sentAt: ago(HOUR / 6) },
      { senderAccountId: 'mb-1', status: 'Unknown', sentAt: ago(20 * HOUR) },
      { senderAccountId: 'mb-1', status: 'Failed', sentAt: ago(HOUR / 6) },
      { senderAccountId: 'mb-1', status: 'Sent', sentAt: ago(24 * HOUR) }, // left the window
      { senderAccountId: 'mb-1', status: 'Sent', sentAt: ago(30 * HOUR) },
      { senderAccountId: 'mb-2', status: 'Sent', sentAt: ago(HOUR) }, // another mailbox
    ];

    const res = await getAccounts();

    expect(res.status).toBe(200);
    const [account] = await res.json();
    expect(account).toMatchObject({ id: 'mb-1', sentLast24Hours: 3, effectiveDailyCap: 50 });
    expect(account).not.toHaveProperty('sentToday');
  });
});

describe('Accounts capacity figures use the caps the send engine enforces (L28)', () => {
  const DAY = 24 * HOUR;
  // Both mailboxes allow 500 a day, but warmup holds them to 5 plus 10 a day since it started.
  const warming = (id: string, startedAgo: number) => ({
    id, dailyLimit: 500, warmupEnabled: true, warmupStartedAt: ago(startedAgo), warmupLimit: 5, warmupRamp: 10, imapPass: null,
  });

  it('reports each mailbox\'s warmup cap, and adds up what each has left of it', async () => {
    mockedDb.getAccounts.mockResolvedValue([warming('mb-1', HOUR), warming('mb-2', 3 * DAY + HOUR)]);
    dispatches = [
      // mb-1 sent 7 before warmup restarted its ramp, over its day-1 cap of 5.
      ...Array.from({ length: 7 }, () => ({ senderAccountId: 'mb-1', status: 'Sent', sentAt: ago(2 * HOUR) })),
      ...Array.from({ length: 5 }, () => ({ senderAccountId: 'mb-2', status: 'Sent', sentAt: ago(2 * HOUR) })),
    ];

    const res = await getAccounts();

    expect(res.status).toBe(200);
    const accounts = await res.json();
    expect(accounts.map((a: any) => [a.id, a.effectiveDailyCap, a.sentLast24Hours])).toEqual([['mb-1', 5, 7], ['mb-2', 35, 5]]);
    // Not 1,000 - 12 from the daily limits, and mb-1's 2 over its cap take nothing from mb-2's 30.
    expect(combinedDailyCapacity(accounts)).toEqual({ sent: 12, cap: 40, remaining: 30 });
  });

  it('falls back to the daily limit for a mailbox listed without a cap', () => {
    expect(combinedDailyCapacity([{ dailyLimit: 200, sentLast24Hours: 50 }, { dailyLimit: 100, effectiveDailyCap: 20 }]))
      .toEqual({ sent: 50, cap: 220, remaining: 170 });
  });
});

describe('with a global rate limit set, the mailboxes share its daily allowance and have no daily limits of their own', () => {
  const DAY = 24 * HOUR;
  const GLOBAL = { id: 'global', activeProvider: 'AZURE', rateLimitMinute: 80, rateLimitHour: 800 };

  it('GET /api/accounts reports no cap for a mailbox that is not warming up, and the ramp alone for one that is', async () => {
    mockedPrisma.globalSettings.findUnique.mockResolvedValue(GLOBAL);
    mockedDb.getAccounts.mockResolvedValue([
      { id: 'mb-1', dailyLimit: 50, warmupEnabled: false, warmupStartedAt: null, warmupLimit: 10, warmupRamp: 2, imapPass: null },
      // The fourth day of a ramp from 5 by 10 a day allows 35, which its daily limit of 20 no longer clamps.
      { id: 'mb-2', dailyLimit: 20, warmupEnabled: true, warmupStartedAt: ago(3 * DAY + HOUR), warmupLimit: 5, warmupRamp: 10, imapPass: null },
    ]);

    const res = await getAccounts();

    expect(res.status).toBe(200);
    const accounts = await res.json();
    expect(accounts.map((a: any) => [a.id, a.effectiveDailyCap])).toEqual([['mb-1', null], ['mb-2', 35]]);
  });

  it('GET /api/accounts/capacity reports the allowance and what the last 24 hours left of it', async () => {
    mockedPrisma.globalSettings.findUnique.mockResolvedValue(GLOBAL);
    dispatches = [
      { senderAccountId: 'mb-1', status: 'Sent', sentAt: ago(HOUR) },
      { senderAccountId: 'mb-2', status: 'Failed', sentAt: ago(2 * HOUR) }, // the global limits count failed sends too
      { senderAccountId: 'mb-1', status: 'Sent', sentAt: ago(30 * HOUR) }, // left the window
    ];

    const res = await getCapacity();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ globalDaily: { limit: 19200, per: 'hour', sent: 2, remaining: 19198 } });
  });

  it('GET /api/accounts/capacity reports no allowance when no global rate limit is set', async () => {
    mockedPrisma.globalSettings.findUnique.mockResolvedValue({ ...GLOBAL, rateLimitMinute: null, rateLimitHour: null });

    const res = await getCapacity();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ globalDaily: null });
  });

  it('takes the allowance from the lower of 24 times the hourly limit and 1,440 times the per-minute one', () => {
    expect(globalDailyCeiling({ minute: 80, hour: 800 })).toEqual({ cap: 19200, per: 'hour' });
    expect(globalDailyCeiling({ minute: 10, hour: 800 })).toEqual({ cap: 14400, per: 'minute' });
    expect(globalDailyCeiling({ minute: 10, hour: null })).toEqual({ cap: 14400, per: 'minute' });
    expect(globalDailyAllowance({ minute: 80, hour: 800 }, 6)).toEqual({ limit: 19200, per: 'hour', sent: 6, remaining: 19194 });
    expect(globalDailyAllowance({ minute: null, hour: 20 }, 500)).toEqual({ limit: 480, per: 'hour', sent: 500, remaining: 0 });
  });

  it('reads a limit of 0 or null as no limit, as the send engine does, which leaves the daily limits on', () => {
    expect(globalDailyCeiling({ minute: 0, hour: null })).toBeNull();
    expect(globalDailyCeiling(null)).toBeNull();
    expect(globalDailyAllowance({ minute: 0, hour: null }, 6)).toBeNull();
    expect(mailboxDailyLimitsOff({ minute: 0, hour: null })).toBe(false);
    expect(mailboxDailyLimitsOff({ minute: null, hour: 800 })).toBe(true);
    expect(mailboxDailyLimitsOff({ minute: 80, hour: null })).toBe(true);
  });

  it('gives each mailbox what is left of the allowance, and a warming one no more than its ramp leaves', () => {
    const allowance = { limit: 19200, per: 'hour' as const, sent: 6, remaining: 19194 };

    // No cap of its own: its daily limit of 500 is off, however much it sent.
    expect(mailboxRemaining({ dailyLimit: 500, effectiveDailyCap: null, sentLast24Hours: 6 }, allowance)).toBe(19194);
    expect(mailboxRemaining({ dailyLimit: 500, effectiveDailyCap: null, sentLast24Hours: 9000 }, allowance)).toBe(19194);
    // Warming up: 44 left of a ramp of 50, and nothing once it is past it.
    expect(mailboxRemaining({ dailyLimit: 500, effectiveDailyCap: 50, sentLast24Hours: 6 }, allowance)).toBe(44);
    expect(mailboxRemaining({ dailyLimit: 500, effectiveDailyCap: 50, sentLast24Hours: 70 }, allowance)).toBe(0);
    // The allowance has less left than the ramp does.
    expect(mailboxRemaining({ effectiveDailyCap: 50, sentLast24Hours: 0 }, { ...allowance, sent: 19190, remaining: 10 })).toBe(10);
  });

  it('gives a mailbox what is left of its own cap when there is no allowance', () => {
    expect(mailboxRemaining({ dailyLimit: 200, sentLast24Hours: 50 }, null)).toBe(150);
    expect(mailboxRemaining({ dailyLimit: 200, effectiveDailyCap: 20, sentLast24Hours: 50 })).toBe(0);
  });
});
