import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../lib/db', () => ({
  db: { getAccounts: vi.fn() },
  prisma: {
    campaign: { findMany: vi.fn() },
    emailDispatch: { count: vi.fn() },
    inboundResponse: { count: vi.fn() },
    campaignEnrollment: { count: vi.fn() },
  },
}));

vi.mock('../../lib/session', () => ({
  getSession: vi.fn(),
}));

import { db, prisma } from '../../lib/db';
import { getSession } from '../../lib/session';
import { GET as getAccounts } from '../../app/api/accounts/route';
import { combinedDailyCapacity } from '../../lib/mailboxCapacity';

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
  throw new Error(`Unmodelled filter: ${JSON.stringify(cond)}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  dispatches = [];
  vi.mocked(getSession).mockResolvedValue({ id: 'admin-1', name: 'Admin', email: 'admin@example.com', role: 'ADMIN' } as any);
  mockedDb.getAccounts.mockResolvedValue([
    { id: 'mb-1', dailyLimit: 50, warmupEnabled: false, warmupStartedAt: null, warmupLimit: 10, warmupRamp: 2, smtpPass: null, imapPass: null },
  ]);
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
    id, dailyLimit: 500, warmupEnabled: true, warmupStartedAt: ago(startedAgo), warmupLimit: 5, warmupRamp: 10, smtpPass: null, imapPass: null,
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
