import { Prisma, type PrismaClient } from '@prisma/client';

/**
 * Engagement metrics, defined once here for the dashboard, the campaigns list,
 * the campaign page and the Accounts page, and aggregated in the database
 * (counts, groupBy and one grouped query for the daily trend), so no page
 * loads dispatch rows to count them.
 *
 * - Sends: only campaign sequence sends count, the dispatches the send engine
 *   makes for a step (stepOrder set). Unibox replies and mailbox test sends
 *   carry no tracking and never count. Sent means ACS accepted the email
 *   (status Sent); a Failed, Sending or Unknown attempt is not a send.
 * - Opened: a person opened the email or clicked a link in it, since a click
 *   means it was opened even when its pixel was blocked. Clicked: a person
 *   clicked a link in it. Each email counts once however often it was opened
 *   or clicked, and hits lib/botFilter judged automated never count.
 * - Open and click rates: opened or clicked emails over the emails that
 *   reached the recipient: delivered where a delivery report says so, else
 *   sent. An email a report says was not delivered (bounced, suppressed,
 *   failed, quarantined or filtered as spam) is left out of both unless a
 *   person opened it, so a rate never passes 100%.
 * - Bounced: hard bounces, reported by the delivery webhook (at bouncedAt) or
 *   found at send time (a Failed dispatch with a 'bounce' event, at its time).
 * - Failed: send attempts that failed (status Failed), at the attempt.
 * - Unsubscribed: emails whose unsubscribe link was used, at the time it was
 *   ('unsubscribe' event, recorded by /api/unsubscribe).
 *
 * Over a period, sends, opens and clicks are those of the emails sent in it;
 * bounces, failures, unsubscribes and replies count in the period they happened.
 */

type MetricsClient = Pick<PrismaClient, 'emailDispatch' | 'inboundResponse' | '$queryRaw'>;

/** Whose sends and replies a metric covers. */
export type MetricsScope =
  /** Every user's (admins). */
  | { kind: 'all' }
  /** The campaigns a user owns, and the replies their mailboxes received. */
  | { kind: 'owner'; userId: string }
  | { kind: 'campaign'; campaignId: string }
  | { kind: 'mailbox'; senderAccountId: string };

/** A time range: from `gte`, up to `lte` (inclusive) or `lt` (exclusive). */
export type Period = { gte: Date; lte?: Date; lt?: Date };

/** EmailEvent types of a person's engagement; lib/botFilter records machine hits under others. */
export const OPEN_EVENT = 'open';
export const CLICK_EVENT = 'click';
/** Recorded by /api/unsubscribe on the email whose unsubscribe link was used. */
export const UNSUBSCRIBE_EVENT = 'unsubscribe';
/** Recorded on a dispatch that hard-bounced, by the send engine at send time and by the delivery webhook. */
const BOUNCE_EVENT = 'bounce';

/** Delivery report statuses that say the email did not reach the recipient (lib/deliveryReport). */
const UNDELIVERED_STATUSES = ['Bounced', 'Suppressed', 'Failed', 'Quarantined', 'FilteredSpam'];

/** Campaign sequence sends: the send engine records their step; Unibox replies and mailbox tests have none. */
export const SEQUENCE_SEND: Prisma.EmailDispatchWhereInput = { stepOrder: { not: null } };

const SENT: Prisma.EmailDispatchWhereInput = { status: 'Sent' };
const DELIVERED: Prisma.EmailDispatchWhereInput = { deliveredAt: { not: null } };
const OPENED: Prisma.EmailDispatchWhereInput = { events: { some: { eventType: { in: [OPEN_EVENT, CLICK_EVENT] } } } };
const CLICKED: Prisma.EmailDispatchWhereInput = { events: { some: { eventType: CLICK_EVENT } } };
/** The open and click rates' base: delivered, or not reported undelivered, or opened (which proves delivery). */
const REACHED: Prisma.EmailDispatchWhereInput = {
  OR: [DELIVERED, { deliveryStatus: null }, { deliveryStatus: { notIn: UNDELIVERED_STATUSES } }, OPENED],
};

/** The metrics scope of a session: admins see everyone's, other users their own. */
export function metricsScopeFor(session: { id: string; role: string }): Extract<MetricsScope, { kind: 'all' | 'owner' }> {
  return session.role === 'ADMIN' ? { kind: 'all' } : { kind: 'owner', userId: session.id };
}

/** `part` as a percentage of `whole`, to one decimal; 0 when there is nothing to divide by. */
export function percent(part: number, whole: number): number {
  return whole > 0 ? Number(((part / whole) * 100).toFixed(1)) : 0;
}

/**
 * The dispatches a scope covers. A sequence send belongs to its campaign's
 * owner, and to the mailbox it was sent from; one made before dispatches
 * recorded their mailbox counts for its campaign's own sender.
 */
function scopeWhere(scope: MetricsScope): Prisma.EmailDispatchWhereInput {
  switch (scope.kind) {
    case 'all':
      return {};
    case 'owner':
      return { campaign: { userId: scope.userId } };
    case 'campaign':
      return { campaignId: scope.campaignId };
    case 'mailbox':
      return {
        OR: [
          { senderAccountId: scope.senderAccountId },
          { senderAccountId: null, campaign: { senderAccountId: scope.senderAccountId } },
        ],
      };
  }
}

/**
 * The replies a scope covers. A reply belongs to the owner of the mailbox it
 * arrived in; one whose mailbox was deleted, to its campaign's owner.
 */
function replyWhere(scope: MetricsScope): Prisma.InboundResponseWhereInput {
  switch (scope.kind) {
    case 'all':
      return {};
    case 'owner':
      return {
        OR: [
          { senderAccount: { userId: scope.userId } },
          { senderAccountId: null, campaign: { userId: scope.userId } },
        ],
      };
    case 'campaign':
      return { campaignId: scope.campaignId };
    case 'mailbox':
      return { senderAccountId: scope.senderAccountId };
  }
}

/** A scope's sequence sends ACS accepted, sent in `sentAt` when given. */
function sentWhere(scope: MetricsScope, sentAt?: Period): Prisma.EmailDispatchWhereInput {
  return { AND: [scopeWhere(scope), SEQUENCE_SEND, SENT, sentAt ? { sentAt } : {}] };
}

/** A scope's hard bounces (see the module comment), those that happened in `period` when given. */
function hardBounceWhere(period?: Period): Prisma.EmailDispatchWhereInput {
  return {
    OR: [
      { bounceType: 'hard', ...(period && { bouncedAt: period }) },
      { status: 'Failed', events: { some: { eventType: BOUNCE_EVENT, ...(period && { timestamp: period }) } } },
    ],
  };
}

export type SendSummary = {
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  deliveryRate: number;
  openRate: number;
  clickRate: number;
};

/** A scope's sends and their delivery, opens and clicks, of the emails sent in `sentAt` when given. */
export async function sendSummary(client: MetricsClient, scope: MetricsScope, sentAt?: Period): Promise<SendSummary> {
  const sent = sentWhere(scope, sentAt);
  const [sentCount, delivered, reached, opened, clicked] = await Promise.all([
    client.emailDispatch.count({ where: sent }),
    client.emailDispatch.count({ where: { AND: [sent, DELIVERED] } }),
    client.emailDispatch.count({ where: { AND: [sent, REACHED] } }),
    client.emailDispatch.count({ where: { AND: [sent, OPENED] } }),
    client.emailDispatch.count({ where: { AND: [sent, CLICKED] } }),
  ]);
  return {
    sent: sentCount,
    delivered,
    opened,
    clicked,
    deliveryRate: percent(delivered, sentCount),
    openRate: percent(opened, reached),
    clickRate: percent(clicked, reached),
  };
}

/** A scope's sequence send attempts, whatever became of them: retries and failures included. */
export function countSendAttempts(client: MetricsClient, scope: MetricsScope): Promise<number> {
  return client.emailDispatch.count({ where: { AND: [scopeWhere(scope), SEQUENCE_SEND] } });
}

/** A scope's hard bounces, those that happened in `period` when given. */
export function countHardBounces(client: MetricsClient, scope: MetricsScope, period?: Period): Promise<number> {
  return client.emailDispatch.count({ where: { AND: [scopeWhere(scope), SEQUENCE_SEND, hardBounceWhere(period)] } });
}

/** A scope's replies, those received in `receivedAt` when given. */
export function countReplies(client: MetricsClient, scope: MetricsScope, receivedAt?: Period): Promise<number> {
  return client.inboundResponse.count({ where: { AND: [replyWhere(scope), receivedAt ? { receivedAt } : {}] } });
}

export type HealthSummary = { bounced: number; failed: number; unsubscribed: number; bounceRate: number };

/**
 * A scope's hard bounces, failed send attempts and unsubscribes, those that
 * happened in `period` when given. The bounce rate is of the emails sent or
 * bounced at send time.
 */
export async function healthSummary(client: MetricsClient, scope: MetricsScope, period?: Period): Promise<HealthSummary> {
  const sequence = { AND: [scopeWhere(scope), SEQUENCE_SEND] };
  const [bounced, bounceBase, failed, unsubscribed] = await Promise.all([
    countHardBounces(client, scope, period),
    client.emailDispatch.count({
      where: { AND: [sequence, { OR: [{ ...SENT, ...(period && { sentAt: period }) }, hardBounceWhere(period)] }] },
    }),
    client.emailDispatch.count({ where: { AND: [sequence, { status: 'Failed' }, period ? { sentAt: period } : {}] } }),
    client.emailDispatch.count({
      where: { AND: [sequence, { events: { some: { eventType: UNSUBSCRIBE_EVENT, ...(period && { timestamp: period }) } } }] },
    }),
  ]);
  return { bounced, failed, unsubscribed, bounceRate: percent(bounced, bounceBase) };
}

export type StepMetrics = {
  sent: number;
  delivered: number;
  failed: number;
  opened: number;
  clicked: number;
  deliveryRate: number;
  openRate: number;
  clickRate: number;
};

/**
 * Per-step sends of each of `campaignIds`, with the same definitions as the
 * campaign totals: sent, delivered and failed attempts, and with `engagement`
 * the opens and clicks too (left 0 without it). Returns a lookup by campaign
 * and step.
 */
export async function stepMetrics(
  client: MetricsClient,
  campaignIds: string[],
  options: { engagement?: boolean } = {},
): Promise<(campaignId: string, stepOrder: number) => StepMetrics> {
  const steps: Prisma.EmailDispatchWhereInput = { AND: [{ campaignId: { in: campaignIds } }, SEQUENCE_SEND] };
  const sent: Prisma.EmailDispatchWhereInput = { AND: [steps, SENT] };
  const countByStep = (where: Prisma.EmailDispatchWhereInput) =>
    client.emailDispatch.groupBy({ by: ['campaignId', 'stepOrder'], where, _count: { id: true } });
  const engagementCount = (where: Prisma.EmailDispatchWhereInput) =>
    options.engagement ? countByStep({ AND: [sent, where] }) : Promise.resolve([]);

  const [byStatus, delivered, reached, opened, clicked] = await Promise.all([
    client.emailDispatch.groupBy({ by: ['campaignId', 'stepOrder', 'status'], where: steps, _count: { id: true } }),
    countByStep({ AND: [sent, DELIVERED] }),
    engagementCount(REACHED),
    engagementCount(OPENED),
    engagementCount(CLICKED),
  ]);

  type Counts = { sent: number; delivered: number; failed: number; reached: number; opened: number; clicked: number };
  const counts = new Map<string, Counts>();
  const key = (campaignId: string | null, stepOrder: number | null) => `${campaignId}:${stepOrder}`;
  const at = (row: { campaignId: string | null; stepOrder: number | null }): Counts => {
    let entry = counts.get(key(row.campaignId, row.stepOrder));
    if (!entry) {
      entry = { sent: 0, delivered: 0, failed: 0, reached: 0, opened: 0, clicked: 0 };
      counts.set(key(row.campaignId, row.stepOrder), entry);
    }
    return entry;
  };
  for (const row of byStatus) {
    if (row.status === 'Sent') at(row).sent += row._count.id;
    else if (row.status === 'Failed') at(row).failed += row._count.id;
  }
  for (const row of delivered) at(row).delivered += row._count.id;
  for (const row of reached) at(row).reached += row._count.id;
  for (const row of opened) at(row).opened += row._count.id;
  for (const row of clicked) at(row).clicked += row._count.id;

  return (campaignId, stepOrder) => {
    const c = counts.get(key(campaignId, stepOrder)) ?? { sent: 0, delivered: 0, failed: 0, reached: 0, opened: 0, clicked: 0 };
    return {
      sent: c.sent,
      delivered: c.delivered,
      failed: c.failed,
      opened: c.opened,
      clicked: c.clicked,
      deliveryRate: percent(c.delivered, c.sent),
      openRate: percent(c.opened, c.reached),
      clickRate: percent(c.clicked, c.reached),
    };
  };
}

/** A period of whole days: each day's local midnight, the period up to now, and the period before it. */
export type MetricsWindow = { days: Date[]; current: Period & { lte: Date }; prior: Period };

/**
 * The last `dayCount` days: today and the `dayCount - 1` days before it, from
 * local midnight, so a trend has one bucket per day and its totals match. The
 * prior period is the `dayCount` whole days before that.
 */
export function metricsWindow(dayCount: number, now: Date = new Date()): MetricsWindow {
  const days: Date[] = [];
  for (let i = dayCount - 1; i >= 0; i--) {
    const day = new Date(now);
    day.setHours(0, 0, 0, 0);
    day.setDate(day.getDate() - i);
    days.push(day);
  }
  const start = days[0];
  const priorStart = new Date(start);
  priorStart.setDate(priorStart.getDate() - dayCount);
  return { days, current: { gte: start, lte: now }, prior: { gte: priorStart, lt: start } };
}

/** A trend bucket's label: 'Sep 30'. */
function dayLabel(day: Date): string {
  return day.toLocaleDateString('en-US', { day: '2-digit', month: 'short' });
}

export type DailyEngagement = { name: string; sent: number; opens: number; clicks: number };

/** The SQL condition for a scope's dispatches `d` (with their campaign `c`). */
function scopeSql(scope: Exclude<MetricsScope, { kind: 'mailbox' }>): Prisma.Sql {
  switch (scope.kind) {
    case 'all':
      return Prisma.sql`TRUE`;
    case 'owner':
      return Prisma.sql`c."userId" = ${scope.userId}`;
    case 'campaign':
      return Prisma.sql`d."campaignId" = ${scope.campaignId}`;
  }
}

/**
 * A scope's sends per day of `span`, with how many of them were opened and
 * clicked, as sendSummary counts them. One grouped query: each dispatch is
 * put in the day it was sent (width_bucket over the days' local midnights).
 */
export async function dailyEngagement(
  client: MetricsClient,
  scope: Exclude<MetricsScope, { kind: 'mailbox' }>,
  span: MetricsWindow,
): Promise<DailyEngagement[]> {
  const dayStarts = Prisma.join(span.days.map((day) => Prisma.sql`${day}::timestamp`));
  const rows = await client.$queryRaw<{ day: number; sent: number; opened: number; clicked: number }[]>(Prisma.sql`
    SELECT t."day",
           COUNT(*)::int AS "sent",
           COUNT(*) FILTER (WHERE t."opened")::int AS "opened",
           COUNT(*) FILTER (WHERE t."clicked")::int AS "clicked"
    FROM (
      SELECT width_bucket(d."sentAt", ARRAY[${dayStarts}]) AS "day",
             EXISTS (
               SELECT 1 FROM "EmailEvent" e
               WHERE e."messageId" = d."messageId" AND e."eventType" IN (${Prisma.join([OPEN_EVENT, CLICK_EVENT])})
             ) AS "opened",
             EXISTS (
               SELECT 1 FROM "EmailEvent" e
               WHERE e."messageId" = d."messageId" AND e."eventType" = ${CLICK_EVENT}
             ) AS "clicked"
      FROM "EmailDispatch" d
      LEFT JOIN "Campaign" c ON c."id" = d."campaignId"
      WHERE d."status" = 'Sent'
        AND d."stepOrder" IS NOT NULL
        AND d."sentAt" >= ${span.current.gte}
        AND d."sentAt" <= ${span.current.lte}
        AND ${scopeSql(scope)}
    ) t
    GROUP BY t."day"
  `);

  return span.days.map((day, i) => {
    // width_bucket numbers the days from 1.
    const row = rows.find((r) => Number(r.day) === i + 1);
    return {
      name: dayLabel(day),
      sent: Number(row?.sent ?? 0),
      opens: Number(row?.opened ?? 0),
      clicks: Number(row?.clicked ?? 0),
    };
  });
}

export type FunnelStage = { name: string; value: number; unit: 'Emails' | 'Replies' | 'Leads' };

/**
 * The conversion funnel's stages, each with the unit it counts, which the
 * charts show: sends, deliveries, opens and clicks are emails, replies are
 * replies received, and meetings booked are leads. Delivered only when given.
 */
export function engagementFunnel(counts: {
  sent: number;
  delivered?: number;
  opened: number;
  clicked: number;
  replies: number;
  meetingsBooked: number;
}): FunnelStage[] {
  return [
    { name: 'Sent', value: counts.sent, unit: 'Emails' },
    ...(counts.delivered === undefined ? [] : [{ name: 'Delivered', value: counts.delivered, unit: 'Emails' as const }]),
    { name: 'Opened', value: counts.opened, unit: 'Emails' },
    { name: 'Clicked', value: counts.clicked, unit: 'Emails' },
    { name: 'Replied', value: counts.replies, unit: 'Replies' },
    { name: 'Meeting Booked', value: counts.meetingsBooked, unit: 'Leads' },
  ];
}
