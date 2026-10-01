import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * The campaign page's Analytics tab: GET /api/campaigns/[id] runs its real
 * queries against in-memory dispatches, replies and enrollments
 * (helpers/prismaWhere). The per-step and per-mailbox lead counts and the
 * lead totals are raw SQL, so the fake answers those with fixed rows and the
 * tests check the SQL asks for the right rows and the rows land where they
 * belong; the SQL itself is run against Postgres by the integration checks.
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
  db: {},
  prisma: fake,
}));

vi.mock('../../lib/session', () => ({
  getSession: vi.fn(),
}));

import { getSession } from '../../lib/session';
import { GET as getCampaign } from '../../app/api/campaigns/[id]/route';
import { campaignLeadTotals, countEngagedBeforeBotFilterFix, deliveryBreakdown, mailboxMetrics, stepMetrics } from '../../lib/engagementMetrics';
import { BOT_FILTER_FIX_AT } from '../../lib/botFilter';
import { emailsLeft, nextSendText } from '../../lib/campaignProgress';
import { countRows, groupRows } from './helpers/prismaWhere';

const USER = { id: 'user-1', name: 'User', email: 'user@example.com', role: 'USER' as const };
const NOW = new Date('2026-09-30T12:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000);

const CAMPAIGN = {
  id: 'cmp-1', name: 'Launch', userId: 'user-1', status: 'Active', senderAccountId: 'mb-1',
  timezone: 'UTC', sendSchedule: null, trackOpens: true, trackClicks: true,
  senderAccount: { id: 'mb-1', emailAddress: 'one@acme.test' }, senders: [],
  steps: [
    { id: 's1', stepOrder: 1, waitDays: 0, subject: 'Hello' },
    { id: 's2', stepOrder: 2, waitDays: 3, subject: 'Follow up' },
    { id: 's3', stepOrder: 3, waitDays: 4, subject: 'Last note' },
  ],
};
const MAILBOXES: Record<string, { id: string; userId: string; emailAddress: string; name: string | null }> = {
  'mb-1': { id: 'mb-1', userId: 'user-1', emailAddress: 'one@acme.test', name: 'One' },
  'mb-2': { id: 'mb-2', userId: 'user-1', emailAddress: 'two@acme.test', name: null },
};

type Event = { eventType: string; timestamp: Date };
type DispatchRow = {
  id: string; leadId: string; campaignId: string; senderAccountId: string | null; status: string; stepOrder: number | null;
  sentAt: Date; deliveredAt: Date | null; deliveryStatus: string | null; bounceType: string | null; bouncedAt: Date | null; events: Event[];
};
type EnrollmentRow = { id: string; campaignId: string; leadId: string; status: string; currentSequenceStep: number; nextActionDate: Date | null };

let dispatches: DispatchRow[];
let enrollments: EnrollmentRow[];
/** Fixed answers to the raw queries, by what they count. */
let raw: { leadsByStep: any[]; leadsByMailbox: any[]; repliedByStep: any[]; repliedByMailbox: any[]; totals: any[] };

function addDispatch(row: Partial<DispatchRow> & { id: string }) {
  dispatches.push({
    leadId: 'lead-1', campaignId: 'cmp-1', senderAccountId: 'mb-1', status: 'Sent', stepOrder: 1, sentAt: hoursAgo(48),
    deliveredAt: null, deliveryStatus: null, bounceType: null, bouncedAt: null, events: [], ...row,
  });
}

function enroll(id: string, status: string, currentSequenceStep: number, nextActionDate: Date | null) {
  enrollments.push({ id, campaignId: 'cmp-1', leadId: `lead-${id}`, status, currentSequenceStep, nextActionDate });
}

const event = (eventType: string): Event => ({ eventType, timestamp: hoursAgo(24) });

const DISPATCH_RELATIONS = {
  campaign: (row: DispatchRow) => (row.campaignId === 'cmp-1' ? CAMPAIGN : null),
  events: (row: DispatchRow) => row.events,
};
const ENROLLMENT_RELATIONS = { lead: () => ({ status: 'Neutral', isArchived: false }) };

/** The SQL text of a raw query. */
const sqlText = (query: any): string => query.text ?? query.strings.join('?');

async function telemetry() {
  const res = await getCampaign(new NextRequest('http://localhost/api/campaigns/cmp-1'), { params: Promise.resolve({ id: 'cmp-1' }) });
  expect(res.status).toBe(200);
  return (await res.json()).telemetry;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.mocked(getSession).mockResolvedValue(USER);
  dispatches = [];
  enrollments = [];
  raw = { leadsByStep: [], leadsByMailbox: [], repliedByStep: [], repliedByMailbox: [], totals: [] };
  fake.campaign.findUnique.mockResolvedValue(CAMPAIGN);
  fake.emailDispatch.count.mockImplementation(async ({ where }: any) => countRows(dispatches, where, DISPATCH_RELATIONS));
  fake.emailDispatch.groupBy.mockImplementation(async (args: any) => groupRows(dispatches, args, DISPATCH_RELATIONS));
  fake.campaignEnrollment.count.mockImplementation(async ({ where }: any) => countRows(enrollments, where, ENROLLMENT_RELATIONS));
  fake.campaignEnrollment.groupBy.mockImplementation(async (args: any) => groupRows(enrollments, args, ENROLLMENT_RELATIONS));
  fake.inboundResponse.count.mockResolvedValue(0);
  fake.lead.count.mockResolvedValue(0);
  fake.lead.groupBy.mockResolvedValue([]);
  fake.senderAccount.findMany.mockImplementation(async ({ where }: any) =>
    Object.values(MAILBOXES).filter((m) => where.id.in.includes(m.id)).map(({ id, emailAddress, name }) => ({ id, emailAddress, name })));
  fake.$queryRaw.mockImplementation(async (query: any) => {
    const text = sqlText(query);
    if (text.includes('width_bucket')) return [];
    if (text.includes('AS "contacted"')) return raw.totals;
    const byStep = text.includes('d."stepOrder" AS "value"');
    if (text.includes('CROSS JOIN LATERAL')) return byStep ? raw.repliedByStep : raw.repliedByMailbox;
    if (text.includes('COUNT(DISTINCT d."leadId")')) return byStep ? raw.leadsByStep : raw.leadsByMailbox;
    throw new Error(`Unexpected raw query: ${text}`);
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("each step's stats use the campaign's definitions", () => {
  it('counts sends, bounces, unsubscribes, opens, clicks, leads and replies per step, with their rates', async () => {
    addDispatch({ id: 'd1', leadId: 'lead-1', deliveredAt: hoursAgo(47), deliveryStatus: 'Delivered', events: [event('open')] });
    addDispatch({ id: 'd2', leadId: 'lead-2', deliveryStatus: 'Bounced', bounceType: 'hard', bouncedAt: hoursAgo(47) });
    // A hard bounce found at send time: a failed attempt, and a bounce.
    addDispatch({ id: 'd3', leadId: 'lead-3', status: 'Failed', events: [event('bounce')] });
    addDispatch({ id: 'd4', leadId: 'lead-4', events: [event('unsubscribe')] });
    // A soft bounce is neither a hard bounce nor reached.
    addDispatch({ id: 'd5', leadId: 'lead-5', deliveryStatus: 'Bounced', bounceType: 'soft', bouncedAt: hoursAgo(47) });
    // Step 2 went to lead-1 twice, and a machine open never counts.
    addDispatch({ id: 'd6', leadId: 'lead-1', stepOrder: 2, events: [event('machine_open')] });
    addDispatch({ id: 'd7', leadId: 'lead-1', stepOrder: 2 });
    addDispatch({ id: 'd8', leadId: 'lead-6', stepOrder: 2, events: [event('click')] });
    raw.leadsByStep = [{ campaignId: 'cmp-1', value: 1, leads: 4 }, { campaignId: 'cmp-1', value: 2, leads: 2 }];
    raw.repliedByStep = [{ campaignId: 'cmp-1', value: 1, leads: 1 }];

    const { stepStats } = await telemetry();

    expect(stepStats[0]).toMatchObject({
      stepOrder: 1, sent: 4, failed: 1, leads: 4,
      // Reports arrived for d1, d2 and d5, and none for d4: the rate is of those 3 (stats A3).
      delivered: 1, deliveryRate: 33.3, reported: 3,
      // Reached: d1 (delivered) and d4 (no report); d2 and d5 bounced.
      opened: 1, openRate: 50, clicked: 0,
      // Hard bounces d2 and d3, over the emails whose outcome is known: the 3
      // reported (d1, d2, d5) and the 1 bounced at send time, not d4 (stats A5).
      bounced: 2, bounceBase: 4, bounceRate: 50,
      unsubscribed: 1, unsubscribeRate: 25,
      replied: 1, replyRate: 25,
    });
    expect(stepStats[1]).toMatchObject({
      stepOrder: 2, sent: 3, leads: 2, reported: 0, opened: 1, clicked: 1, openRate: 33.3, clickRate: 33.3,
      bounced: 0, unsubscribed: 0, replied: 0, replyRate: 0,
    });
    expect(stepStats[2]).toMatchObject({ stepOrder: 3, sent: 0, leads: 0, replied: 0, replyRate: 0 });
  });

  it('asks the database for the leads each step went to and the leads who replied after it', async () => {
    await stepMetrics(fake as any, ['cmp-1', 'cmp-2'], { leads: true, replies: true });

    const queries = fake.$queryRaw.mock.calls.map(([query]) => query);
    const leads = queries.find((q) => !sqlText(q).includes('LATERAL'));
    const replied = queries.find((q) => sqlText(q).includes('LATERAL'));
    expect(sqlText(leads)).toContain('COUNT(DISTINCT d."leadId")');
    expect(sqlText(leads)).toContain(`d."status" = 'Sent'`);
    expect(sqlText(leads)).toContain('GROUP BY d."campaignId", d."stepOrder"');
    expect(leads.values).toEqual(['cmp-1', 'cmp-2']);
    // A reply goes to the step of the latest email of its campaign sent to the lead before it.
    for (const clause of [
      'r."autoReply" IS NULL', `e."status" <> 'Failed'`, 'e."sentAt" <= r."receivedAt"',
      'e."campaignId" = r."campaignId"', 'e."leadId" = r."leadId"', 'ORDER BY e."sentAt" DESC, e."id" DESC', 'LIMIT 1',
      'COUNT(DISTINCT r."leadId")',
    ]) {
      expect(sqlText(replied)).toContain(clause);
    }
    expect(replied.values).toEqual(['cmp-1', 'cmp-2']);
  });

  it('runs no raw query for no campaigns, or when leads and replies are not asked for', async () => {
    await stepMetrics(fake as any, [], { leads: true, replies: true });
    await stepMetrics(fake as any, ['cmp-1'], { engagement: true, health: true });
    expect(fake.$queryRaw).not.toHaveBeenCalled();
  });
});

describe('the mailboxes a campaign sent from', () => {
  it('breaks the sends down by mailbox, most sent first, and keeps sends with no recorded mailbox apart', async () => {
    addDispatch({ id: 'd1', senderAccountId: 'mb-1', events: [event('open')] });
    addDispatch({ id: 'd2', senderAccountId: 'mb-1' });
    addDispatch({ id: 'd3', senderAccountId: 'mb-2', deliveryStatus: 'Bounced', bounceType: 'hard', bouncedAt: hoursAgo(40) });
    addDispatch({ id: 'd4', senderAccountId: null, status: 'Failed' });
    raw.leadsByMailbox = [{ campaignId: 'cmp-1', value: 'mb-1', leads: 2 }, { campaignId: 'cmp-1', value: 'mb-2', leads: 1 }];
    raw.repliedByMailbox = [{ campaignId: 'cmp-1', value: 'mb-2', leads: 1 }];

    const { mailboxes } = await telemetry();

    expect(mailboxes.map((m: any) => [m.senderAccountId, m.emailAddress, m.sent, m.failed])).toEqual([
      ['mb-1', 'one@acme.test', 2, 0],
      ['mb-2', 'two@acme.test', 1, 0],
      [null, null, 0, 1],
    ]);
    expect(mailboxes[0]).toMatchObject({ opened: 1, openRate: 50, leads: 2, replied: 0 });
    expect(mailboxes[1]).toMatchObject({ bounced: 1, bounceBase: 1, bounceRate: 100, replied: 1, replyRate: 100 });
    // The addresses are looked up only for the mailboxes the sends recorded.
    expect(fake.senderAccount.findMany.mock.calls[0][0].where).toEqual({ id: { in: ['mb-1', 'mb-2'] } });
  });

  it('groups the raw counts by mailbox', async () => {
    await mailboxMetrics(fake as any, 'cmp-1');
    for (const [query] of fake.$queryRaw.mock.calls) {
      expect(sqlText(query)).toContain('d."senderAccountId" AS "value"');
      expect(sqlText(query)).toContain('GROUP BY');
    }
    expect(fake.$queryRaw).toHaveBeenCalledTimes(2);
  });
});

describe('what delivery reports said', () => {
  it('counts each accepted email once: a bounce by its type, else its report, else no report yet', async () => {
    addDispatch({ id: 'delivered', deliveryStatus: 'Delivered', deliveredAt: hoursAgo(47) });
    // Delivered first, then a hard bounce report: a bounce.
    addDispatch({ id: 'hard', deliveryStatus: 'Bounced', deliveredAt: hoursAgo(47), bounceType: 'hard', bouncedAt: hoursAgo(46) });
    addDispatch({ id: 'soft', deliveryStatus: 'Failed', bounceType: 'soft', bouncedAt: hoursAgo(46) });
    addDispatch({ id: 'spam', deliveryStatus: 'FilteredSpam' });
    addDispatch({ id: 'held', deliveryStatus: 'Quarantined' });
    addDispatch({ id: 'list', deliveryStatus: 'Expanded' });
    addDispatch({ id: 'none-1' });
    addDispatch({ id: 'none-2' });
    // Not accepted, or not a sequence send: not in the breakdown.
    addDispatch({ id: 'failed', status: 'Failed' });
    addDispatch({ id: 'unibox', stepOrder: null, deliveryStatus: 'Delivered' });

    expect(await deliveryBreakdown(fake as any, { kind: 'campaign', campaignId: 'cmp-1' })).toEqual({
      accepted: 8, reported: 6, delivered: 1, expanded: 1, spam: 1, quarantined: 1,
      softBounced: 1, hardBounced: 1, otherReported: 0, noReport: 2,
    });
  });

  it('says no report has arrived rather than showing nothing delivered', async () => {
    addDispatch({ id: 'd1' });
    addDispatch({ id: 'd2' });

    const { delivery } = await telemetry();

    expect(delivery).toMatchObject({ accepted: 2, reported: 0, noReport: 2, delivered: 0 });
  });
});

describe('failed send attempts', () => {
  it("counts every failed attempt of the campaign's sequence, whenever it was made, with no before-and-after split", async () => {
    addDispatch({ id: 'old', status: 'Failed', sentAt: hoursAgo(24 * 60) });
    addDispatch({ id: 'new', leadId: 'lead-2', stepOrder: 2, status: 'Failed', sentAt: hoursAgo(1) });
    // Accepted, not a sequence send, or another campaign's: not counted.
    addDispatch({ id: 'sent', leadId: 'lead-3' });
    addDispatch({ id: 'unibox', stepOrder: null, status: 'Failed' });
    addDispatch({ id: 'other', campaignId: 'cmp-2', status: 'Failed' });

    const t = await telemetry();

    expect(t.failed).toBe(2);
    expect(t).not.toHaveProperty('failedBeforeStatusCheckFix');
  });
});

describe('opens and clicks recorded before the current bot filter (stats A7)', () => {
  const DAY = 24 * 3600_000;
  /** `ms` before or after the bot filter went live. */
  const beforeFix = (ms: number) => new Date(BOT_FILTER_FIX_AT.getTime() - ms);
  const afterFix = (ms: number) => new Date(BOT_FILTER_FIX_AT.getTime() + ms);
  const hit = (eventType: string, timestamp: Date): Event => ({ eventType, timestamp });

  it('counts the opened and clicked emails with a hit recorded before it, overall and in the trend, so the page can say they include scanner hits', async () => {
    vi.setSystemTime(afterFix(2 * DAY));
    // In the trend's 7 days: opened 30 s after sending, as a scanner does.
    addDispatch({ id: 'old-open', sentAt: beforeFix(DAY), events: [hit('open', beforeFix(DAY - 30_000))] });
    // Before the trend's 7 days: clicked, which counts as opened too.
    addDispatch({ id: 'old-click', leadId: 'lead-2', stepOrder: 2, sentAt: beforeFix(10 * DAY), events: [hit('click', beforeFix(10 * DAY - 20_000))] });
    // An old email opened after the fix went through the current filter, as did a new one's hits.
    addDispatch({ id: 'old-email-new-open', leadId: 'lead-3', sentAt: beforeFix(DAY), events: [hit('open', afterFix(DAY))] });
    addDispatch({ id: 'new', leadId: 'lead-4', sentAt: afterFix(DAY), events: [hit('open', afterFix(DAY)), hit('click', afterFix(DAY))] });
    // Not counted: a machine hit, a failed attempt, a Unibox reply and another campaign's email.
    addDispatch({ id: 'machine', leadId: 'lead-5', sentAt: beforeFix(DAY), events: [hit('machine_open', beforeFix(DAY - 5_000))] });
    addDispatch({ id: 'failed', leadId: 'lead-6', status: 'Failed', sentAt: beforeFix(DAY), events: [hit('open', beforeFix(DAY - 30_000))] });
    addDispatch({ id: 'unibox', stepOrder: null, sentAt: beforeFix(DAY), events: [hit('click', beforeFix(DAY - 30_000))] });
    addDispatch({ id: 'other', campaignId: 'cmp-2', sentAt: beforeFix(DAY), events: [hit('click', beforeFix(DAY - 30_000))] });

    const t = await telemetry();

    // Unique Opens and Clicks still count every hit they counted before.
    expect(t).toMatchObject({ opens: 4, clicks: 2 });
    expect(t.engagedBeforeBotFilterFix).toEqual({ opened: 2, clicked: 1 });
    expect(t.trendEngagedBeforeBotFilterFix).toEqual({ opened: 1, clicked: 0 });
  });

  it('counts none for a campaign whose opens and clicks were all recorded after it', async () => {
    vi.setSystemTime(afterFix(20 * DAY));
    addDispatch({ id: 'old-email-new-open', sentAt: beforeFix(DAY), events: [hit('open', afterFix(DAY))] });
    addDispatch({ id: 'new', leadId: 'lead-2', sentAt: afterFix(19 * DAY), events: [hit('click', afterFix(19 * DAY + 60_000))] });

    const t = await telemetry();

    expect(t).toMatchObject({ opens: 2, clicks: 1 });
    expect(t.engagedBeforeBotFilterFix).toEqual({ opened: 0, clicked: 0 });
    expect(t.trendEngagedBeforeBotFilterFix).toEqual({ opened: 0, clicked: 0 });
  });

  it('asks for the clicked emails only once some opened ones are found, and asks nothing for a period that starts after it', async () => {
    const scope = { kind: 'campaign', campaignId: 'cmp-1' } as const;
    addDispatch({ id: 'new', sentAt: afterFix(DAY), events: [hit('click', afterFix(DAY))] });

    fake.emailDispatch.count.mockClear();
    expect(await countEngagedBeforeBotFilterFix(fake as any, scope)).toEqual({ opened: 0, clicked: 0 });
    expect(fake.emailDispatch.count).toHaveBeenCalledTimes(1);

    addDispatch({ id: 'old', leadId: 'lead-2', sentAt: beforeFix(DAY), events: [hit('click', beforeFix(DAY - 20_000))] });

    // No email sent after the fix has a hit from before it.
    fake.emailDispatch.count.mockClear();
    expect(await countEngagedBeforeBotFilterFix(fake as any, scope, { gte: BOT_FILTER_FIX_AT, lte: afterFix(DAY) })).toEqual({ opened: 0, clicked: 0 });
    expect(fake.emailDispatch.count).not.toHaveBeenCalled();

    expect(await countEngagedBeforeBotFilterFix(fake as any, scope)).toEqual({ opened: 1, clicked: 1 });
    expect(fake.emailDispatch.count).toHaveBeenCalledTimes(2);
  });
});

describe('the leads the opened and clicked emails came from (stats A8)', () => {
  it('gives the Unique Opens and Unique Clicks tiles the leads their emails came from, each once', async () => {
    // lead-1 opened three emails, one of them only by a click; lead-2 opened one.
    addDispatch({ id: 'd1', events: [event('open')] });
    addDispatch({ id: 'd2', stepOrder: 2, events: [event('open'), event('open')] });
    addDispatch({ id: 'd3', stepOrder: 3, events: [event('click')] });
    addDispatch({ id: 'd4', leadId: 'lead-2', events: [event('open')] });
    // A machine hit opens nothing.
    addDispatch({ id: 'd5', leadId: 'lead-3', events: [event('machine_click')] });
    raw.totals = [{ contacted: 3, opened: 2, clicked: 1, replied: 0, firstSentAt: hoursAgo(48), lastSentAt: hoursAgo(48) }];

    const t = await telemetry();

    expect(t).toMatchObject({ opens: 4, openedLeads: 2, clicks: 1, clickedLeads: 1 });
    expect(t.progress.contacted).toBe(3);
  });

  it("counts them in the lead totals' one query, over the accepted sequence emails and a person's opens and clicks only", async () => {
    raw.totals = [{ contacted: 20608, opened: 2131, clicked: 1173, replied: 0, firstSentAt: null, lastSentAt: null }];

    expect(await campaignLeadTotals(fake as any, 'cmp-1')).toMatchObject({ contacted: 20608, opened: 2131, clicked: 1173 });

    expect(fake.$queryRaw).toHaveBeenCalledTimes(1);
    const [query] = fake.$queryRaw.mock.calls[0];
    for (const clause of [
      'COUNT(DISTINCT d."leadId") FILTER (WHERE e."eventType" IS NOT NULL)::int AS "opened"',
      'COUNT(DISTINCT d."leadId") FILTER (WHERE e."eventType" = $2)::int AS "clicked"',
      'LEFT JOIN "EmailEvent" e',
      'ON e."messageId" = d."messageId" AND e."eventType" IN ($3,$4)',
      `d."stepOrder" IS NOT NULL AND d."status" = 'Sent'`,
    ]) {
      expect(sqlText(query)).toContain(clause);
    }
    // Only a person's opens and clicks are joined, so machine hits, bounces and unsubscribes open nothing.
    expect(query.values).toEqual(['cmp-1', 'click', 'open', 'click', 'cmp-1']);
  });

  it('counts no leads for a campaign with no sends', async () => {
    expect(await campaignLeadTotals(fake as any, 'cmp-1')).toEqual({
      contacted: 0, opened: 0, clicked: 0, replied: 0, firstSentAt: null, lastSentAt: null,
    });
  });
});

describe('the reply rate counts leads, as every other reply figure does (stats A12)', () => {
  it('gives the leads who replied of the leads contacted, so a lead who replies more than once counts once', async () => {
    // Four emails to two leads; lead-1 replied three times.
    addDispatch({ id: 'd1' });
    addDispatch({ id: 'd2', stepOrder: 2 });
    addDispatch({ id: 'd3', stepOrder: 3 });
    addDispatch({ id: 'd4', leadId: 'lead-2' });
    fake.inboundResponse.count.mockResolvedValue(3);
    raw.totals = [{ contacted: 2, opened: 0, clicked: 0, replied: 1, firstSentAt: hoursAgo(48), lastSentAt: hoursAgo(48) }];

    const t = await telemetry();

    // Old tile: 3 replies / 4 emails = 75%, against Lead Progress's 1 of 2 contacted leads.
    expect(t).toMatchObject({ sent: 4, replies: 3, replyRate: 50 });
    expect(t.progress).toMatchObject({ contacted: 2, repliedLeads: 1 });
  });
});

describe("where the campaign's leads are", () => {
  it('counts every enrollment by status, the emails still to send and when the next is due', async () => {
    enroll('e1', 'Active', 1, hoursAgo(2)); // due
    enroll('e2', 'Active', 1, hoursAgo(-20));
    enroll('e3', 'Active', 2, hoursAgo(5)); // due, and the earliest
    enroll('e4', 'Completed', 3, null);
    enroll('e5', 'Paused', 2, null);
    enroll('e6', 'Bounced', 2, null);
    enroll('e7', 'Failed', 1, null);
    enroll('e8', 'Removed', 2, null);
    raw.totals = [{ contacted: 5, replied: 2, firstSentAt: hoursAgo(100), lastSentAt: hoursAgo(3) }];

    const { progress, stepStats, activeEnrollments } = await telemetry();

    expect(progress).toEqual({
      enrolled: 8,
      byStatus: { Active: 3, Completed: 1, Paused: 1, Bounced: 1, Failed: 1, Removed: 1 },
      contacted: 5,
      repliedLeads: 2,
      // Two leads waiting for step 1 get steps 1-3, one waiting for step 2 gets steps 2-3.
      emailsLeft: 8,
      dueNow: 2,
      nextDueAt: hoursAgo(5).toISOString(),
      firstSentAt: hoursAgo(100).toISOString(),
      lastSentAt: hoursAgo(3).toISOString(),
    });
    expect(activeEnrollments).toBe(3);
    expect(stepStats.map((s: any) => [s.stepOrder, s.active, s.due, s.nextDueAt])).toEqual([
      [1, 2, 1, hoursAgo(2).toISOString()],
      [2, 1, 1, hoursAgo(5).toISOString()],
      [3, 0, 0, null],
    ]);
  });

  it('shows no totals, and no next send, for a campaign with no enrollments or sends', async () => {
    const { progress } = await telemetry();

    expect(progress).toEqual({
      enrolled: 0, byStatus: {}, contacted: 0, repliedLeads: 0, emailsLeft: 0, dueNow: 0,
      nextDueAt: null, firstSentAt: null, lastSentAt: null,
    });
  });
});

describe('lib/campaignProgress', () => {
  it('counts each waiting lead\'s step and every step after it, and none for a step the campaign no longer has', () => {
    expect(emailsLeft([1, 2, 3], [{ stepOrder: 1, waiting: 2 }, { stepOrder: 3, waiting: 5 }])).toBe(11);
    expect(emailsLeft([1, 2], [{ stepOrder: 4, waiting: 7 }])).toBe(0);
    expect(emailsLeft([], [])).toBe(0);
  });

  it('says when the next email is due, or why none is', () => {
    const format = (at: Date) => `at ${at.toISOString()}`;
    const later = new Date(NOW.getTime() + 3600_000);
    expect(nextSendText({ status: 'Active' }, hoursAgo(1), NOW, format)).toBe('Due now');
    expect(nextSendText({ status: 'Active' }, later.toISOString(), NOW, format)).toBe(`at ${later.toISOString()}`);
    expect(nextSendText({ status: 'Active' }, null, NOW, format)).toBe('No lead waiting');
    expect(nextSendText({ status: 'Paused' }, hoursAgo(1), NOW, format)).toBe('None while paused');
    expect(nextSendText({ status: 'Stopped' }, hoursAgo(1), NOW, format)).toBe('None while stopped');
    expect(nextSendText({ status: 'Draft' }, hoursAgo(1), NOW, format)).toBe('Not published');
  });
});
