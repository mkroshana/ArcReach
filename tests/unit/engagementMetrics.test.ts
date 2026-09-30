import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * The dashboard, campaign page and Accounts page run their real queries
 * against in-memory dispatches and replies (helpers/prismaWhere), so each test
 * checks the numbers every page shows for the same rows.
 */
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
import { GET as getCampaign } from '../../app/api/campaigns/[id]/route';
import { GET as getDashboardStats } from '../../app/api/dashboard-stats/route';
import { GET as getAccounts } from '../../app/api/accounts/route';
import { dailyEngagement, metricsWindow, stepMetrics } from '../../lib/engagementMetrics';
import { countRows, groupRows } from './helpers/prismaWhere';

const mockedSession = vi.mocked(getSession);
const USER = { id: 'user-1', name: 'User', email: 'user@example.com', role: 'USER' as const };
const OTHER_USER = { id: 'user-2', name: 'Other', email: 'other@example.com', role: 'USER' as const };
const ADMIN = { id: 'admin-1', name: 'Admin', email: 'admin@example.com', role: 'ADMIN' as const };

// 6pm local time, so a send at noon today is inside the period.
const NOW = new Date(2026, 8, 30, 18, 0, 0);
/** Noon (local) `days` days before NOW. */
const at = (days: number, hour = 12) => new Date(2026, 8, 30 - days, hour, 0, 0);

const CAMPAIGNS: Record<string, { id: string; name: string; userId: string; senderAccountId: string }> = {
  'cmp-1': { id: 'cmp-1', name: 'Launch', userId: 'user-1', senderAccountId: 'mb-1' },
  'cmp-2': { id: 'cmp-2', name: 'Other', userId: 'user-2', senderAccountId: 'mb-2' },
};
const MAILBOXES: Record<string, { id: string; userId: string }> = {
  'mb-1': { id: 'mb-1', userId: 'user-1' },
  'mb-2': { id: 'mb-2', userId: 'user-2' },
};

type Event = { eventType: string; timestamp: Date };
type DispatchRow = {
  id: string; leadId: string | null; campaignId: string | null; senderAccountId: string | null;
  status: string; stepOrder: number | null; sentAt: Date; deliveredAt: Date | null; deliveryStatus: string | null;
  bounceType: string | null; bouncedAt: Date | null; events: Event[];
};
type ReplyRow = { id: string; campaignId: string | null; senderAccountId: string | null; receivedAt: Date };

let dispatches: DispatchRow[];
let replies: ReplyRow[];

/** A step-1 send of cmp-1 from mb-1 that ACS accepted yesterday, by default. */
function addDispatch(row: Partial<DispatchRow> & { id: string }) {
  dispatches.push({
    leadId: 'lead-1', campaignId: 'cmp-1', senderAccountId: 'mb-1', status: 'Sent', stepOrder: 1, sentAt: at(1),
    deliveredAt: null, deliveryStatus: null, bounceType: null, bouncedAt: null, events: [], ...row,
  });
}

const event = (eventType: string, timestamp = at(1, 13)): Event => ({ eventType, timestamp });

const DISPATCH_RELATIONS = {
  campaign: (row: DispatchRow) => (row.campaignId ? CAMPAIGNS[row.campaignId] : null),
  senderAccount: (row: DispatchRow) => (row.senderAccountId ? MAILBOXES[row.senderAccountId] : null),
  events: (row: DispatchRow) => row.events,
};
const REPLY_RELATIONS = {
  campaign: (row: ReplyRow) => (row.campaignId ? CAMPAIGNS[row.campaignId] : null),
  senderAccount: (row: ReplyRow) => (row.senderAccountId ? MAILBOXES[row.senderAccountId] : null),
};

async function campaignTelemetry(id = 'cmp-1') {
  const res = await getCampaign(new NextRequest(`http://localhost/api/campaigns/${id}`), { params: Promise.resolve({ id }) });
  expect(res.status).toBe(200);
  return (await res.json()).telemetry;
}

async function dashboard(range: number | string = 7) {
  const res = await getDashboardStats(new NextRequest(`http://localhost/api/dashboard-stats?range=${range}`));
  expect(res.status).toBe(200);
  return res.json();
}

async function mailbox(id = 'mb-1') {
  vi.mocked(db.getAccounts).mockResolvedValue([
    { id, dailyLimit: 50, warmupEnabled: false, warmupStartedAt: null, warmupLimit: 10, warmupRamp: 2, imapPass: null },
  ] as any);
  const res = await getAccounts();
  expect(res.status).toBe(200);
  return (await res.json())[0];
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  mockedSession.mockResolvedValue(USER);
  dispatches = [];
  replies = [];
  for (const model of [fake.campaign, fake.campaignEnrollment, fake.emailDispatch, fake.inboundResponse, fake.lead]) {
    model.count.mockResolvedValue(0);
    model.groupBy.mockResolvedValue([]);
    model.findMany.mockResolvedValue([]);
  }
  fake.campaign.findUnique.mockImplementation(async ({ where }: any) => ({
    ...CAMPAIGNS[where.id],
    steps: [{ stepOrder: 1, subject: 'Hello', waitDays: 0 }, { stepOrder: 2, subject: 'Follow up', waitDays: 3 }],
  }));
  fake.emailDispatch.count.mockImplementation(async ({ where }: any) => countRows(dispatches, where, DISPATCH_RELATIONS));
  fake.emailDispatch.groupBy.mockImplementation(async (args: any) => groupRows(dispatches, args, DISPATCH_RELATIONS));
  fake.inboundResponse.count.mockImplementation(async ({ where }: any) => countRows(replies, where, REPLY_RELATIONS));
  // The campaign page names the mailboxes its sends came from.
  fake.senderAccount.findMany.mockImplementation(async ({ where }: any) =>
    Object.values(MAILBOXES).filter((m) => where.id.in.includes(m.id)).map((m) => ({ id: m.id, emailAddress: `${m.id}@acme.test`, name: null })));
  fake.$queryRaw.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('open and click rates have one definition on every page (M30, L8)', () => {
  /** Ten sends: two confirmed delivered, six with no report, one bounced, one quarantined. */
  function tenSends() {
    addDispatch({ id: 'd1', deliveredAt: at(1), deliveryStatus: 'Delivered', events: [event('open')] });
    // Images blocked: clicked without the pixel ever loading.
    addDispatch({ id: 'd2', deliveredAt: at(1), deliveryStatus: 'Delivered', events: [event('click')] });
    addDispatch({ id: 'd3', events: [event('open'), event('click'), event('open')] });
    addDispatch({ id: 'd4', events: [event('open')] });
    addDispatch({ id: 'd5', events: [event('machine_open')] });
    addDispatch({ id: 'd6' });
    addDispatch({ id: 'd7' });
    addDispatch({ id: 'd8' });
    addDispatch({ id: 'd9', deliveryStatus: 'Bounced', bounceType: 'hard', bouncedAt: at(1) });
    addDispatch({ id: 'd10', deliveryStatus: 'Quarantined' });
  }

  it('divides opens and clicks by the emails delivered or not reported undelivered, so partial delivery reports never push a rate past 100%', async () => {
    tenSends();

    // Old campaign page: 3 pixel opens / 2 delivered = 150%.
    const telemetry = await campaignTelemetry();
    expect(telemetry).toMatchObject({
      sent: 10, delivered: 2, opens: 4, clicks: 2, deliveryRate: 20, openRate: 50, clickRate: 25,
    });
    expect(telemetry.stepStats[0]).toMatchObject({ stepOrder: 1, sent: 10, delivered: 2, opened: 4, clicked: 2, openRate: 50, clickRate: 25 });

    const { stats } = await dashboard();
    expect(stats).toMatchObject({ totalSent: 10, averageOpenRate: 50, averageClickRate: 25 });

    expect(await mailbox()).toMatchObject({ sentTotal: 10, delivered: 2, opens: 4, clicks: 2, openRate: 50, clickRate: 25 });
  });

  it('counts a click as an open, so the funnel never shows Clicked above Opened, and names what each stage counts (L9)', async () => {
    addDispatch({ id: 'd1', events: [event('click')] });
    addDispatch({ id: 'd2', events: [event('click')] });
    addDispatch({ id: 'd3' });
    replies.push({ id: 'r1', campaignId: 'cmp-1', senderAccountId: 'mb-1', receivedAt: at(0) });

    const { funnel } = await dashboard();
    expect(funnel).toEqual([
      { name: 'Sent', value: 3, unit: 'Emails' },
      { name: 'Opened', value: 2, unit: 'Emails' },
      { name: 'Clicked', value: 2, unit: 'Emails' },
      { name: 'Replied', value: 1, unit: 'Replies' },
      { name: 'Meeting Booked', value: 0, unit: 'Leads' },
    ]);

    const telemetry = await campaignTelemetry();
    expect(telemetry.funnel.map((s: any) => [s.name, s.value, s.unit])).toEqual([
      ['Sent', 3, 'Emails'], ['Delivered', 0, 'Emails'], ['Opened', 2, 'Emails'], ['Clicked', 2, 'Emails'],
      ['Replied', 1, 'Replies'], ['Meeting Booked', 0, 'Leads'],
    ]);
    expect(telemetry).toMatchObject({ opens: 2, clicks: 2, openRate: 66.7, clickRate: 66.7 });
  });

  it('gives the campaigns list the per-step sends the campaign page shows', async () => {
    addDispatch({ id: 'd1', deliveredAt: at(1) });
    addDispatch({ id: 'd2', status: 'Failed' });
    addDispatch({ id: 'd3', stepOrder: 2 });
    addDispatch({ id: 'd4', stepOrder: 2, status: 'Sending' });

    const listed = await stepMetrics(fake as any, ['cmp-1', 'cmp-2']);
    const { stepStats } = await campaignTelemetry();
    for (const step of stepStats) {
      const { sent, delivered, failed } = listed('cmp-1', step.stepOrder);
      expect({ sent, delivered, failed }).toEqual({ sent: step.sent, delivered: step.delivered, failed: step.failed });
    }
    expect(stepStats.map((s: any) => [s.sent, s.delivered, s.failed])).toEqual([[1, 1, 1], [1, 0, 0]]);
  });
});

describe('only campaign sequence sends ACS accepted count as sent (L7, M38)', () => {
  it('leaves Unibox replies, mailbox test sends and failed attempts out of every page\'s sends and rates', async () => {
    addDispatch({ id: 'd1', events: [event('open')] });
    addDispatch({ id: 'd2' });
    addDispatch({ id: 'failed', status: 'Failed' });
    // A Unibox reply is stamped with the campaign of the inbound it answers.
    addDispatch({ id: 'unibox', stepOrder: null });
    addDispatch({ id: 'test-send', leadId: null, campaignId: null, stepOrder: null });

    expect(await campaignTelemetry()).toMatchObject({ sent: 2, sentRequests: 3, failed: 1, openRate: 50 });
    expect((await dashboard()).stats).toMatchObject({ totalSent: 2, averageOpenRate: 50, failed: 1 });
    mockedSession.mockResolvedValue(ADMIN);
    expect((await dashboard()).stats).toMatchObject({ totalSent: 2, averageOpenRate: 50 });
    // Old Accounts page: 4 sent (the failed attempt, the reply and the test counted), 25% open rate.
    expect(await mailbox()).toMatchObject({ sentTotal: 2, openRate: 50 });
  });

  it('counts a hard bounce found at send time as Bounced on the Accounts page, the campaign page and the dashboard', async () => {
    addDispatch({ id: 'd1' });
    addDispatch({ id: 'bounced-at-send', status: 'Failed', sentAt: at(0), events: [event('bounce', at(0))] });
    // A soft failure is a failed attempt, not a bounce.
    addDispatch({ id: 'soft', status: 'Failed', sentAt: at(0), events: [event('send_failed', at(0))] });

    expect(await mailbox()).toMatchObject({ sentTotal: 1, bounced: 1 });
    expect(await campaignTelemetry()).toMatchObject({ sent: 1, bounced: 1, failed: 2, bounceRate: 50 });
    expect((await dashboard()).stats).toMatchObject({ bounced: 1, failed: 2 });
  });
});

describe('a non-admin dashboard counts only what they own (M28)', () => {
  it('counts sends by the campaign that made them and replies by the mailbox they arrived in, not by shared leads', async () => {
    addDispatch({ id: 'mine-1' });
    addDispatch({ id: 'mine-2' });
    // Another user's campaign mailing the same lead.
    for (const id of ['theirs-1', 'theirs-2', 'theirs-3']) {
      addDispatch({ id, campaignId: 'cmp-2', senderAccountId: 'mb-2', events: [event('open')] });
    }
    replies.push(
      { id: 'r-mine', campaignId: 'cmp-1', senderAccountId: 'mb-1', receivedAt: at(0) },
      // Arrived in user-2's mailbox; reply matching stamped the lead's latest campaign, user-1's.
      { id: 'r-theirs', campaignId: 'cmp-1', senderAccountId: 'mb-2', receivedAt: at(0) },
      // Its mailbox was deleted, so its campaign decides.
      { id: 'r-orphan', campaignId: 'cmp-1', senderAccountId: null, receivedAt: at(0) },
    );

    expect((await dashboard()).stats).toMatchObject({ totalSent: 2, averageOpenRate: 0, totalReplies: 2 });
    mockedSession.mockResolvedValue(OTHER_USER);
    expect((await dashboard()).stats).toMatchObject({ totalSent: 3, averageOpenRate: 100, totalReplies: 1 });
    mockedSession.mockResolvedValue(ADMIN);
    expect((await dashboard()).stats).toMatchObject({ totalSent: 5, averageOpenRate: 60, totalReplies: 3 });
  });
});

describe('unsubscribes, failures and bounces count by the campaign and the time they happened (M31)', () => {
  it('counts a campaign\'s own unsubscribes and failed attempts, and the dashboard\'s by when they happened', async () => {
    // Sent before the period, unsubscribed in it.
    addDispatch({ id: 'unsub-now', sentAt: at(10), events: [event('unsubscribe', at(0))] });
    addDispatch({ id: 'unsub-before', sentAt: at(25), events: [event('unsubscribe', at(20))] });
    addDispatch({ id: 'failed-now', status: 'Failed', sentAt: at(0) });
    addDispatch({ id: 'failed-before', status: 'Failed', sentAt: at(20) });
    addDispatch({ id: 'bounced-now', sentAt: at(10), bounceType: 'hard', bouncedAt: at(0) });
    // The old count: enrollments whose lead is Unsubscribed, in any campaign, at any time.
    fake.campaignEnrollment.count.mockResolvedValue(50);

    expect((await dashboard()).stats).toMatchObject({ unsubscribed: 1, failed: 1, bounced: 1 });
    expect(await campaignTelemetry('cmp-1')).toMatchObject({ unsubscribed: 2, failed: 2, bounced: 1 });

    mockedSession.mockResolvedValue(ADMIN);
    expect(await campaignTelemetry('cmp-2')).toMatchObject({ sent: 0, unsubscribed: 0, failed: 0, bounced: 0 });
  });
});

describe('"last N days" covers exactly N days (M29)', () => {
  it('starts today\'s window at local midnight N - 1 days ago, with the N days before it as the prior period', () => {
    const window = metricsWindow(7, NOW);

    expect(window.days).toEqual([24, 25, 26, 27, 28, 29, 30].map((d) => new Date(2026, 8, d)));
    expect(window.current).toEqual({ gte: new Date(2026, 8, 24), lte: NOW });
    expect(window.prior).toEqual({ gte: new Date(2026, 8, 17), lt: new Date(2026, 8, 24) });
    expect(metricsWindow(1, NOW).days).toEqual([new Date(2026, 8, 30)]);
  });

  it('shows no change at a flat send rate', async () => {
    // One send a day for two weeks. The old 8-day window showed 8 sent, +14.3%.
    for (let day = 0; day < 14; day++) addDispatch({ id: `d${day}`, sentAt: at(day) });

    const { stats, trends } = await dashboard(7);
    expect(stats.totalSent).toBe(7);
    expect(stats.deltas.sent).toBe(0);
    expect(trends).toHaveLength(7);
  });

  it('counts the 7, 30 or 90 days the page offers, and 7 for any other range (M39)', async () => {
    for (let day = 0; day < 100; day++) addDispatch({ id: `d${day}`, sentAt: at(day) });

    for (const [range, days] of [[7, 7], [30, 30], [90, 90], [365, 7], [100000000, 7], [0, 7], [-30, 7], ['abc', 7], ['', 7]] as const) {
      fake.$queryRaw.mockClear();
      const { stats, trends } = await dashboard(range);
      expect(stats.totalSent).toBe(days);
      expect(trends).toHaveLength(days);
      // One day-start parameter per bucket, so the query stays as small as the range.
      expect(fake.$queryRaw.mock.calls[0][0].values.filter((v: unknown) => v instanceof Date)).toHaveLength(days + 2);
    }
  });

  it('asks the database for one bucket per day of the same window and fills the days it returns nothing for', async () => {
    const window = metricsWindow(7, NOW);
    fake.$queryRaw.mockResolvedValue([
      { day: 1, sent: 3, opened: 2, clicked: 1 },
      { day: 7, sent: 5, opened: 1, clicked: 0 },
    ]);

    const trend = await dailyEngagement(fake as any, { kind: 'owner', userId: 'user-1' }, window);

    expect(trend).toHaveLength(7);
    expect(trend[0]).toEqual({ name: 'Sep 24', sent: 3, opens: 2, clicks: 1 });
    expect(trend[3]).toEqual({ name: 'Sep 27', sent: 0, opens: 0, clicks: 0 });
    expect(trend[6]).toEqual({ name: 'Sep 30', sent: 5, opens: 1, clicks: 0 });

    const query = fake.$queryRaw.mock.calls[0][0];
    expect(query.text).toContain('width_bucket(d."sentAt", ARRAY[$1::timestamp,$2::timestamp,$3::timestamp,$4::timestamp,$5::timestamp,$6::timestamp,$7::timestamp])');
    expect(query.text).toContain('d."stepOrder" IS NOT NULL');
    expect(query.text).toContain('c."userId" = $');
    expect(query.values).toEqual([...window.days, 'open', 'click', 'click', window.current.gte, NOW, 'user-1']);
  });
});
