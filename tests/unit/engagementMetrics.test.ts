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
import { dailyEngagement, healthSummary, metricsWindow, percent, stepMetrics } from '../../lib/engagementMetrics';
import { BOT_FILTER_FIX_AT } from '../../lib/botFilter';
import { countRows, groupRows, matchesWhere } from './helpers/prismaWhere';

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
/** Each mailbox's IMAP columns a test sets; with none its reply sync is off. */
let imap: Record<string, Record<string, unknown>>;

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
  imap = {};
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
  // The campaign page names the mailboxes its sends came from; the dashboard reads their reply sync.
  fake.senderAccount.findMany.mockImplementation(async ({ where }: any) =>
    Object.values(MAILBOXES)
      .map((m) => ({ ...m, emailAddress: `${m.id}@acme.test`, name: null, status: 'Active', ...imap[m.id] }))
      .filter((m) => matchesWhere(m, where)));
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

    // No delivery report arrived, so the campaign funnel has no Delivered stage either (stats A2).
    const telemetry = await campaignTelemetry();
    expect(telemetry.funnel.map((s: any) => [s.name, s.value, s.unit])).toEqual([
      ['Sent', 3, 'Emails'], ['Opened', 2, 'Emails'], ['Clicked', 2, 'Emails'],
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

describe('Delivered is unknown, not 0, until a delivery report arrives (stats A1)', () => {
  it('gives the campaigns list and the Accounts page how many sent emails a delivery report arrived for', async () => {
    // Sent before delivery reports, so none arrived.
    addDispatch({ id: 'd1' });
    addDispatch({ id: 'd2', stepOrder: 2 });
    addDispatch({ id: 'failed', status: 'Failed' });
    // Another mailbox's report says nothing about mb-1's emails.
    addDispatch({ id: 'theirs', campaignId: 'cmp-2', senderAccountId: 'mb-2', deliveredAt: at(1), deliveryStatus: 'Delivered' });

    expect(await mailbox()).toMatchObject({ sentTotal: 2, delivered: 0, reported: 0 });
    let listed = await stepMetrics(fake as any, ['cmp-1'], { reports: true });
    expect([1, 2].map((step) => listed('cmp-1', step).reported)).toEqual([0, 0]);

    // A report that the email was not delivered is still a report, so that step's 0 delivered is measured.
    addDispatch({ id: 'd3', stepOrder: 2, deliveryStatus: 'Bounced', bounceType: 'soft', bouncedAt: at(1) });
    addDispatch({ id: 'd4', deliveredAt: at(1), deliveryStatus: 'Delivered' });

    expect(await mailbox()).toMatchObject({ sentTotal: 4, delivered: 1, reported: 2 });
    listed = await stepMetrics(fake as any, ['cmp-1'], { reports: true });
    const counts = (step: number) => {
      const { sent, delivered, reported } = listed('cmp-1', step);
      return { sent, delivered, reported };
    };
    expect([counts(1), counts(2)]).toEqual([{ sent: 2, delivered: 1, reported: 1 }, { sent: 2, delivered: 0, reported: 1 }]);
    // The count the campaign page's step rows load with the rest of their health measures.
    const { stepStats } = await campaignTelemetry();
    expect(stepStats.map((s: any) => s.reported)).toEqual([1, 1]);
  });

  it('loads the reported count with one grouped count, and only when asked', async () => {
    addDispatch({ id: 'd1', deliveredAt: at(1), deliveryStatus: 'Delivered' });

    const plain = await stepMetrics(fake as any, ['cmp-1']);
    expect(plain('cmp-1', 1)).toMatchObject({ sent: 1, delivered: 1, reported: 0 });
    const plainQueries = fake.emailDispatch.groupBy.mock.calls.length;

    fake.emailDispatch.groupBy.mockClear();
    const withReports = await stepMetrics(fake as any, ['cmp-1'], { reports: true });
    expect(withReports('cmp-1', 1)).toMatchObject({ sent: 1, delivered: 1, reported: 1 });
    expect(fake.emailDispatch.groupBy).toHaveBeenCalledTimes(plainQueries + 1);
    expect(fake.emailDispatch.count).not.toHaveBeenCalled();
    expect(fake.$queryRaw).not.toHaveBeenCalled();
  });

  it('leaves the campaign funnel\'s Delivered stage out until a report arrives for one of its emails, then draws it (stats A2)', async () => {
    // Sent before delivery reports, so none arrived.
    addDispatch({ id: 'd1', events: [event('open')] });
    addDispatch({ id: 'd2' });
    // Another campaign's report says nothing about cmp-1's emails.
    addDispatch({ id: 'theirs', campaignId: 'cmp-2', senderAccountId: 'mb-2', deliveredAt: at(1), deliveryStatus: 'Delivered' });
    const stages = async () => (await campaignTelemetry()).funnel.map((s: any) => [s.name, s.value]);

    expect(await stages()).toEqual([['Sent', 2], ['Opened', 1], ['Clicked', 0], ['Replied', 0], ['Meeting Booked', 0]]);

    // A report that the email was not delivered is still a report, so the stage's 0 is now measured.
    addDispatch({ id: 'd3', deliveryStatus: 'Bounced', bounceType: 'soft', bouncedAt: at(1) });
    expect(await stages()).toEqual([['Sent', 3], ['Delivered', 0], ['Opened', 1], ['Clicked', 0], ['Replied', 0], ['Meeting Booked', 0]]);

    addDispatch({ id: 'd4', deliveredAt: at(1), deliveryStatus: 'Delivered' });
    expect(await stages()).toEqual([['Sent', 4], ['Delivered', 1], ['Opened', 1], ['Clicked', 0], ['Replied', 0], ['Meeting Booked', 0]]);
  });
});

describe('the bounce rate is of the emails whose outcome is known, to two decimals (stats A5)', () => {
  it('leaves out the emails no delivery report arrived for, so they never dilute the rate, on the campaign, each step and each mailbox', async () => {
    // No report arrived for these yet: each may still bounce.
    for (let i = 1; i <= 6; i++) addDispatch({ id: `old-${i}` });
    addDispatch({ id: 'delivered-1', deliveredAt: at(1), deliveryStatus: 'Delivered' });
    addDispatch({ id: 'delivered-2', deliveredAt: at(1), deliveryStatus: 'Delivered' });
    addDispatch({ id: 'hard', deliveryStatus: 'Bounced', bounceType: 'hard', bouncedAt: at(1) });
    // A soft bounce is a known outcome that is not a hard bounce.
    addDispatch({ id: 'soft', deliveryStatus: 'Bounced', bounceType: 'soft', bouncedAt: at(1) });
    // Refused when sending: a known outcome with no report.
    addDispatch({ id: 'at-send', status: 'Failed', events: [event('bounce')] });
    // Failed for another reason: its outcome is not a bounce, nor a send.
    addDispatch({ id: 'failed', status: 'Failed', events: [event('send_failed')] });

    // The old base, every email sent plus the send-time bounce, read 2 of 11 = 18.2%.
    const telemetry = await campaignTelemetry();
    expect(telemetry).toMatchObject({ sent: 10, bounced: 2, bouncedInRate: 2, bounceBase: 5, bounceRate: 40 });
    expect(telemetry.stepStats[0]).toMatchObject({ sent: 10, bounced: 2, bouncedInRate: 2, bounceBase: 5, bounceRate: 40 });
    expect(telemetry.mailboxes[0]).toMatchObject({ senderAccountId: 'mb-1', bounced: 2, bouncedInRate: 2, bounceBase: 5, bounceRate: 40 });
  });

  it('counts the bounces found when sending before delivery reports arrived, but leaves them out of the rate, so it is the rate of the newer emails alone', async () => {
    // Before delivery reports: 52 addresses refused when sending (their bounce
    // events recorded since, as backfill B4 does) and accepted emails that
    // never get a report, on both steps.
    for (let i = 1; i <= 50; i++) addDispatch({ id: `old-refused-${i}`, status: 'Failed', sentAt: at(20), events: [event('bounce', at(0))] });
    for (let i = 1; i <= 2; i++) addDispatch({ id: `old-refused-step-2-${i}`, stepOrder: 2, status: 'Failed', sentAt: at(20), events: [event('bounce', at(0))] });
    for (let i = 1; i <= 10; i++) addDispatch({ id: `old-sent-${i}`, stepOrder: (i % 2) + 1, sentAt: at(20) });
    // The campaign resumes with delivery reports, and the first arrives.
    addDispatch({ id: 'new-1', sentAt: at(2), deliveredAt: at(2), deliveryStatus: 'Delivered' });

    // Over that one report, the old bounces would read 52 of 53 = 98.11%.
    let telemetry = await campaignTelemetry();
    expect(telemetry).toMatchObject({ bounced: 52, bouncedInRate: 0, bounceBase: 1, bounceRate: 0 });

    // 98 more newly reported emails, 3 of them hard bounces, and 1 refused
    // when sending since: 4 bounces in the 100 newer emails whose outcome is known.
    for (let i = 2; i <= 96; i++) addDispatch({ id: `new-${i}`, sentAt: at(1), deliveredAt: at(1), deliveryStatus: 'Delivered' });
    for (let i = 1; i <= 3; i++) addDispatch({ id: `new-hard-${i}`, sentAt: at(1), deliveryStatus: 'Bounced', bounceType: 'hard', bouncedAt: at(1) });
    addDispatch({ id: 'new-refused', status: 'Failed', sentAt: at(1), events: [event('bounce', at(1))] });

    telemetry = await campaignTelemetry();
    const newerEmails = { bouncedInRate: 4, bounceBase: 100, bounceRate: 4 };
    expect(telemetry).toMatchObject({ bounced: 56, ...newerEmails });
    expect(telemetry.stepStats[0]).toMatchObject({ bounced: 54, ...newerEmails });
    expect(telemetry.mailboxes[0]).toMatchObject({ senderAccountId: 'mb-1', bounced: 56, ...newerEmails });
    // No report arrived for step 2's emails, so its old bounces have no rate.
    expect(telemetry.stepStats[1]).toMatchObject({ reported: 0, bounced: 2, bouncedInRate: 0, bounceBase: 0, bounceRate: 0 });
  });

  it('keeps two decimals, so a few bounces in many emails do not read 0%', async () => {
    addDispatch({ id: 'hard', deliveryStatus: 'Bounced', bounceType: 'hard', bouncedAt: at(1) });
    addDispatch({ id: 'delivered-1', deliveredAt: at(1), deliveryStatus: 'Delivered' });
    addDispatch({ id: 'delivered-2', deliveredAt: at(1), deliveryStatus: 'Delivered' });

    // Other rates keep one decimal.
    expect(await campaignTelemetry()).toMatchObject({ bounced: 1, bounceBase: 3, bounceRate: 33.33, deliveryRate: 66.7 });
    // 52 bounces in 187,852 emails is 0.03%, which one decimal rounds to 0.
    expect(percent(52, 187_852, 2)).toBe(0.03);
    expect(percent(52, 187_852)).toBe(0);
  });

  it('counts a period\'s base by when the reported emails were sent and when the bounces happened', async () => {
    const period = { gte: at(6, 0), lte: NOW };
    addDispatch({ id: 'reported-in', deliveredAt: at(1), deliveryStatus: 'Delivered' });
    addDispatch({ id: 'reported-before', sentAt: at(20), deliveredAt: at(20), deliveryStatus: 'Delivered' });
    addDispatch({ id: 'unreported-in' });
    // Sent before the period, bounced in it.
    addDispatch({ id: 'bounced-in', sentAt: at(20), deliveryStatus: 'Bounced', bounceType: 'hard', bouncedAt: at(2) });

    expect(await healthSummary(fake as any, { kind: 'campaign', campaignId: 'cmp-1' }, period))
      .toMatchObject({ bounced: 1, bouncedInRate: 1, bounceBase: 2, bounceRate: 50 });
  });
});

describe('the dashboard says replies are not read while no mailbox has reply sync on (stats A11)', () => {
  const IMAP = { imapHost: 'imap.acme.test', imapPort: 993, imapUser: 'sales@acme.test', imapPass: 'encrypted' };

  /** What the dashboard says about replies: its reply-sync state, the count, and the funnel's stages. */
  async function shown() {
    const { stats, funnel } = await dashboard();
    return { replySync: stats.replySync, totalReplies: stats.totalReplies, stages: funnel.map((s: any) => [s.name, s.value]) };
  }

  it('leaves Replied out of the funnel while no mailbox reads replies, and draws its 0 once one does', async () => {
    addDispatch({ id: 'd1' });

    expect(await shown()).toEqual({
      replySync: 'off', totalReplies: 0,
      stages: [['Sent', 1], ['Opened', 0], ['Clicked', 0], ['Meeting Booked', 0]],
    });

    // A paused mailbox is never synced, whatever its IMAP details.
    imap['mb-1'] = { ...IMAP, status: 'Paused' };
    expect((await shown()).replySync).toBe('off');

    // IMAP saved and not synced yet: replies are read from now on, so the 0 is a count.
    imap['mb-1'] = IMAP;
    expect(await shown()).toEqual({
      replySync: 'waiting', totalReplies: 0,
      stages: [['Sent', 1], ['Opened', 0], ['Clicked', 0], ['Replied', 0], ['Meeting Booked', 0]],
    });
  });

  it("reads the reply sync of the mailboxes whose replies it counts: the user's own, or every one for admins", async () => {
    imap['mb-2'] = { ...IMAP, imapLastSyncAt: at(0) };

    expect((await dashboard()).stats.replySync).toBe('off');
    expect(fake.senderAccount.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: { userId: 'user-1' } }));
    mockedSession.mockResolvedValue(OTHER_USER);
    expect((await dashboard()).stats.replySync).toBe('ok');
    mockedSession.mockResolvedValue(ADMIN);
    expect((await dashboard()).stats.replySync).toBe('ok');
  });

  it('still counts the replies recorded before reply sync was turned off', async () => {
    replies.push({ id: 'r1', campaignId: 'cmp-1', senderAccountId: 'mb-1', receivedAt: at(0) });

    const { stats, funnel } = await dashboard();
    expect(stats).toMatchObject({ replySync: 'off', totalReplies: 1 });
    expect(funnel).toContainEqual({ name: 'Replied', value: 1, unit: 'Replies' });
  });
});

describe('the dashboard and the Accounts page say which opens and clicks were recorded before the current bot filter (stats A7)', () => {
  const DAY = 24 * 3600_000;
  /** `ms` before the bot filter went live. */
  const beforeFix = (ms: number) => new Date(BOT_FILTER_FIX_AT.getTime() - ms);

  it('counts them in the period and in the prior one its changes compare with, and for each mailbox', async () => {
    // This period: opened 30 s after sending, as a scanner does.
    addDispatch({ id: 'current', sentAt: beforeFix(DAY), events: [event('open', beforeFix(DAY - 30_000))] });
    // The prior period: clicked, which counts as opened too.
    addDispatch({ id: 'prior', leadId: 'lead-2', sentAt: beforeFix(10 * DAY), events: [event('click', beforeFix(10 * DAY - 20_000))] });
    // A machine hit never counts; another user's campaign counts on its own mailbox only.
    addDispatch({ id: 'machine', leadId: 'lead-3', sentAt: beforeFix(DAY), events: [event('machine_click', beforeFix(DAY - 5_000))] });
    addDispatch({ id: 'theirs', campaignId: 'cmp-2', senderAccountId: 'mb-2', sentAt: beforeFix(DAY), events: [event('click', beforeFix(DAY - 30_000))] });

    const { stats } = await dashboard();
    expect(stats.engagedBeforeBotFilterFix).toEqual({ opened: 1, clicked: 0 });
    expect(stats.priorEngagedBeforeBotFilterFix).toEqual({ opened: 1, clicked: 1 });

    expect((await mailbox('mb-1')).engagedBeforeBotFilterFix).toEqual({ opened: 2, clicked: 1 });
    expect((await mailbox('mb-2')).engagedBeforeBotFilterFix).toEqual({ opened: 1, clicked: 1 });
  });

  it('counts none where every open and click was recorded after it', async () => {
    addDispatch({ id: 'old-email-new-open', sentAt: beforeFix(DAY), events: [event('open', new Date(BOT_FILTER_FIX_AT.getTime() + 60_000))] });

    const { stats } = await dashboard();
    expect(stats.averageOpenRate).toBe(100);
    expect(stats.engagedBeforeBotFilterFix).toEqual({ opened: 0, clicked: 0 });
    expect(stats.priorEngagedBeforeBotFilterFix).toEqual({ opened: 0, clicked: 0 });
    expect((await mailbox()).engagedBeforeBotFilterFix).toEqual({ opened: 0, clicked: 0 });
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
    // No report arrived for any of the campaign's emails, so the bounce found
    // when sending is counted with no rate, not as 100% (stats A5).
    expect(await campaignTelemetry()).toMatchObject({ sent: 1, bounced: 1, failed: 2, bouncedInRate: 0, bounceBase: 0, bounceRate: 0 });
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
