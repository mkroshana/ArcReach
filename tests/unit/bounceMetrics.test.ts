import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/** Every model gets the read methods the stats routes use. */
const fake = vi.hoisted(() => {
  const methods = ['findUnique', 'findMany', 'count', 'groupBy'];
  const model = () => Object.fromEntries(methods.map((n) => [n, vi.fn()]));
  return {
    campaign: model(),
    campaignEnrollment: model(),
    emailDispatch: model(),
    inboundResponse: model(),
    lead: model(),
  };
});

vi.mock('../../lib/db', () => ({
  db: { getAccounts: vi.fn() },
  prisma: fake,
}));

vi.mock('../../lib/session', () => ({
  getSession: vi.fn(),
}));

import { db } from '../../lib/db';
import { getSession } from '../../lib/session';
import { GET as getCampaign } from '../../app/api/campaigns/[id]/route';
import { GET as getDashboardStats } from '../../app/api/dashboard-stats/route';
import { GET as getAccounts } from '../../app/api/accounts/route';

const mockedSession = vi.mocked(getSession);
const USER = { id: 'user-1', name: 'User', email: 'user@example.com', role: 'USER' as const };
const ADMIN = { id: 'admin-1', name: 'Admin', email: 'admin@example.com', role: 'ADMIN' as const };

const NOW = new Date();
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86400000);

/** Who owns each campaign, and the mailbox it names as its sender. */
const CAMPAIGNS: Record<string, { userId: string; senderAccountId: string }> = {
  'cmp-1': { userId: 'user-1', senderAccountId: 'mb-1' },
  'cmp-2': { userId: 'user-2', senderAccountId: 'mb-2' },
};

type DispatchRow = {
  id: string; campaignId: string | null; senderAccountId: string | null; status: string; sentAt: Date;
  bounceType: string | null; bouncedAt: Date | null; deliveredAt: Date | null;
};

let dispatches: DispatchRow[];

function addDispatch(row: Partial<DispatchRow> & { id: string }) {
  dispatches.push({
    campaignId: 'cmp-1', senderAccountId: 'mb-1', status: 'Sent', sentAt: daysAgo(1),
    bounceType: null, bouncedAt: null, deliveredAt: null, ...row,
  });
}

/** Filters the fake leaves at 0: relations to events, leads and replies are not under test here. */
const UNMODELLED = ['events', 'lead'];

/** Evaluates a dispatch filter; throws on shapes it doesn't model so a changed query can't silently match. */
function matches(row: any, where: Record<string, any>): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return cond.some((w: any) => matches(row, w));
    if (key === 'campaign') return !!row.campaignId && matches(CAMPAIGNS[row.campaignId], cond);
    if (cond === null || typeof cond !== 'object') return (row[key] ?? null) === cond;
    return Object.entries(cond).every(([op, value]: [string, any]) => {
      switch (op) {
        case 'in': return value.includes(row[key]);
        case 'notIn': return !value.includes(row[key]);
        case 'not': return value === null ? row[key] != null : row[key] !== value;
        case 'gt': return row[key] != null && row[key] > value;
        case 'gte': return row[key] != null && row[key] >= value;
        case 'lt': return row[key] != null && row[key] < value;
        case 'lte': return row[key] != null && row[key] <= value;
        default: throw new Error(`Unmodelled filter: ${key} ${JSON.stringify(cond)}`);
      }
    });
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mockedSession.mockResolvedValue(USER);
  dispatches = [];
  for (const model of Object.values(fake)) {
    model.count.mockResolvedValue(0);
    model.groupBy.mockResolvedValue([]);
    model.findMany.mockResolvedValue([]);
  }
  fake.campaign.findUnique.mockResolvedValue({ id: 'cmp-1', name: 'Launch', userId: 'user-1', steps: [{ stepOrder: 1 }] });
  fake.emailDispatch.count.mockImplementation(async ({ where }: any) => {
    if (Object.keys(where).some((key) => UNMODELLED.includes(key))) return 0;
    return dispatches.filter((d) => matches(d, where)).length;
  });
  // Enrollment statuses no longer say anything about bounces: a last step's
  // enrollment is Completed before its delivery report arrives.
  fake.campaignEnrollment.count.mockResolvedValue(0);
});

describe('Bounced metrics come from the dispatches the webhook marked hard-bounced (H21)', () => {
  it('counts a one-step campaign\'s hard bounces whatever its enrollments say, not its soft ones or another campaign\'s', async () => {
    addDispatch({ id: 'd-1', bounceType: 'hard', bouncedAt: daysAgo(1) });
    addDispatch({ id: 'd-2', bounceType: 'soft', bouncedAt: daysAgo(1) });
    addDispatch({ id: 'd-3', deliveredAt: daysAgo(1) });
    addDispatch({ id: 'd-4', campaignId: 'cmp-2', senderAccountId: 'mb-2', bounceType: 'hard', bouncedAt: daysAgo(1) });

    const res = await getCampaign(new NextRequest('http://localhost/api/campaigns/cmp-1'), {
      params: Promise.resolve({ id: 'cmp-1' }),
    });

    expect(res.status).toBe(200);
    const { telemetry } = await res.json();
    expect(telemetry).toMatchObject({ sent: 3, bounced: 1, bounceRate: 33.3 });
  });

  it('counts the user\'s own campaigns\' hard bounces in the dashboard period by when they bounced', async () => {
    addDispatch({ id: 'd-1', bounceType: 'hard', bouncedAt: daysAgo(1) });
    // Sent before the period, bounced in it.
    addDispatch({ id: 'd-2', sentAt: daysAgo(20), bounceType: 'hard', bouncedAt: daysAgo(2) });
    addDispatch({ id: 'd-3', bounceType: 'hard', bouncedAt: daysAgo(20) }); // bounced before the period
    addDispatch({ id: 'd-4', bounceType: 'soft', bouncedAt: daysAgo(1) });
    addDispatch({ id: 'd-5', campaignId: 'cmp-2', senderAccountId: 'mb-2', bounceType: 'hard', bouncedAt: daysAgo(1) });

    const res = await getDashboardStats(new NextRequest('http://localhost/api/dashboard-stats?range=7'));
    expect(res.status).toBe(200);
    expect((await res.json()).stats.bounced).toBe(2);

    mockedSession.mockResolvedValue(ADMIN);
    const adminRes = await getDashboardStats(new NextRequest('http://localhost/api/dashboard-stats?range=7'));
    expect((await adminRes.json()).stats.bounced).toBe(3);
  });

  it('counts a mailbox\'s hard bounces on the sends it made, pooled campaigns included', async () => {
    vi.mocked(db.getAccounts).mockResolvedValue([
      { id: 'mb-1', dailyLimit: 50, warmupEnabled: false, warmupStartedAt: null, warmupLimit: 10, warmupRamp: 2, smtpPass: null, imapPass: null },
    ] as any);
    addDispatch({ id: 'd-1', bounceType: 'hard', bouncedAt: daysAgo(1) });
    // Sent by mb-1 from a pool on a campaign whose own sender is mb-2.
    addDispatch({ id: 'd-2', campaignId: 'cmp-2', bounceType: 'hard', bouncedAt: daysAgo(1) });
    addDispatch({ id: 'd-3', bounceType: 'soft', bouncedAt: daysAgo(1) });
    addDispatch({ id: 'd-4', senderAccountId: 'mb-2', campaignId: 'cmp-2', bounceType: 'hard', bouncedAt: daysAgo(1) });

    const res = await getAccounts();

    expect(res.status).toBe(200);
    const [account] = await res.json();
    expect(account).toMatchObject({ id: 'mb-1', sentTotal: 3, bounced: 2 });
  });
});
