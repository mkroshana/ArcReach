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
    senderAccount: model(),
    // No settings row: no global rate limit, so each mailbox is held to its own daily limit.
    globalSettings: { findUnique: vi.fn(), findFirst: vi.fn() },
    $queryRaw: vi.fn(),
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
import { countRows } from './helpers/prismaWhere';
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
  stepOrder: number | null; bounceType: string | null; bouncedAt: Date | null; deliveredAt: Date | null;
  deliveryStatus: string | null; events: { eventType: string; timestamp: Date }[];
};

let dispatches: DispatchRow[];

/** A campaign's step-1 send by default. */
function addDispatch(row: Partial<DispatchRow> & { id: string }) {
  dispatches.push({
    campaignId: 'cmp-1', senderAccountId: 'mb-1', status: 'Sent', sentAt: daysAgo(1), stepOrder: 1,
    bounceType: null, bouncedAt: null, deliveredAt: null, deliveryStatus: null, events: [], ...row,
  });
}

/** A dispatch's campaign and events, for relation filters. */
const RELATIONS = {
  campaign: (row: DispatchRow) => (row.campaignId ? CAMPAIGNS[row.campaignId] : null),
  events: (row: DispatchRow) => row.events,
};

beforeEach(() => {
  vi.resetAllMocks();
  mockedSession.mockResolvedValue(USER);
  dispatches = [];
  for (const model of [fake.campaign, fake.campaignEnrollment, fake.emailDispatch, fake.inboundResponse, fake.lead, fake.senderAccount]) {
    model.count.mockResolvedValue(0);
    model.groupBy.mockResolvedValue([]);
    model.findMany.mockResolvedValue([]);
  }
  fake.campaign.findUnique.mockResolvedValue({ id: 'cmp-1', name: 'Launch', userId: 'user-1', steps: [{ stepOrder: 1 }] });
  fake.emailDispatch.count.mockImplementation(async ({ where }: any) => countRows(dispatches, where, RELATIONS));
  fake.$queryRaw.mockResolvedValue([]);
  // Enrollment statuses no longer say anything about bounces: a last step's
  // enrollment is Completed before its delivery report arrives.
  fake.campaignEnrollment.count.mockResolvedValue(0);
});

describe('Bounced metrics come from the dispatches the webhook marked hard-bounced (H21)', () => {
  it('counts a one-step campaign\'s hard bounces whatever its enrollments say, not its soft ones or another campaign\'s', async () => {
    addDispatch({ id: 'd-1', deliveryStatus: 'Bounced', bounceType: 'hard', bouncedAt: daysAgo(1) });
    addDispatch({ id: 'd-2', deliveryStatus: 'Bounced', bounceType: 'soft', bouncedAt: daysAgo(1) });
    addDispatch({ id: 'd-3', deliveryStatus: 'Delivered', deliveredAt: daysAgo(1) });
    addDispatch({ id: 'd-4', campaignId: 'cmp-2', senderAccountId: 'mb-2', deliveryStatus: 'Bounced', bounceType: 'hard', bouncedAt: daysAgo(1) });

    const res = await getCampaign(new NextRequest('http://localhost/api/campaigns/cmp-1'), {
      params: Promise.resolve({ id: 'cmp-1' }),
    });

    expect(res.status).toBe(200);
    const { telemetry } = await res.json();
    // Of the 3 emails a delivery report arrived for, to two decimals (stats A5).
    expect(telemetry).toMatchObject({ sent: 3, bounced: 1, bounceBase: 3, bounceRate: 33.33 });
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
      { id: 'mb-1', dailyLimit: 50, warmupEnabled: false, warmupStartedAt: null, warmupLimit: 10, warmupRamp: 2, imapPass: null },
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
