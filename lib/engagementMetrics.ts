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
 * - Delivered: a delivery report said the email was delivered and none since
 *   bounced it or filed it as spam: its delivery status is Delivered and it
 *   has no bounce. Such a later report replaces the status but leaves
 *   deliveredAt set, so Delivered goes by the status, as deliveryBreakdown
 *   does, and the email counts under that later outcome alone, never as both.
 *   Delivery rate: delivered emails over the emails any delivery report
 *   arrived for, so the emails whose report has not arrived never dilute it.
 * - Open and click rates: opened or clicked emails over the emails that
 *   reached the recipient: delivered where a delivery report says so, else
 *   sent. An email a report says was not delivered (bounced, suppressed,
 *   failed, quarantined or filtered as spam) is left out of both unless a
 *   person opened it, so a rate never passes 100%.
 * - Bounced: hard bounces, reported by the delivery webhook (at bouncedAt) or
 *   found at send time (a Failed dispatch with a 'bounce' event, at its time).
 * - Bounce rate: hard bounces over the emails whose outcome is known, those a
 *   delivery report arrived for and those bounced at send time, so emails no
 *   report has arrived for never dilute it. To two decimals, so a small rate
 *   does not round to 0.
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
/** Delivered, and no later report bounced it or filed it as spam, which leaves deliveredAt set (see the module comment). */
const DELIVERED: Prisma.EmailDispatchWhereInput = { deliveryStatus: 'Delivered', bounceType: null };
/** A delivery report arrived for the email; until one does, its delivered count says nothing. */
const REPORTED: Prisma.EmailDispatchWhereInput = { deliveryStatus: { not: null } };
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

/** `part` as a percentage of `whole`, to `decimals` places (one by default); 0 when there is nothing to divide by. */
export function percent(part: number, whole: number, decimals = 1): number {
  return whole > 0 ? Number(((part / whole) * 100).toFixed(decimals)) : 0;
}

/** Bounce rates are small, so they keep two decimals: 1 bounce in 5,000 emails is 0.02%, not 0%. */
const BOUNCE_RATE_DECIMALS = 2;

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

/**
 * The bounce rate's base: the emails whose outcome is known, those ACS
 * accepted that a delivery report arrived for (sent in `period` when given)
 * and the hard bounces (in `period`), reported or found at send time. An
 * email no report has arrived for may yet bounce, so it is left out rather
 * than counted as not bounced.
 */
function bounceBaseWhere(period?: Period): Prisma.EmailDispatchWhereInput {
  return { OR: [{ AND: [SENT, REPORTED, period ? { sentAt: period } : {}] }, hardBounceWhere(period)] };
}

export type SendSummary = {
  sent: number;
  delivered: number;
  /**
   * Sent emails any delivery report arrived for: the delivery rate's base.
   * With none, the delivered count is not a measurement, so pages show it as
   * unknown rather than 0.
   */
  reported: number;
  opened: number;
  clicked: number;
  /** `delivered` of `reported`. */
  deliveryRate: number;
  openRate: number;
  clickRate: number;
};

/** A scope's sends and their delivery, opens and clicks, of the emails sent in `sentAt` when given. */
export async function sendSummary(client: MetricsClient, scope: MetricsScope, sentAt?: Period): Promise<SendSummary> {
  const sent = sentWhere(scope, sentAt);
  const [sentCount, delivered, reported, reached, opened, clicked] = await Promise.all([
    client.emailDispatch.count({ where: sent }),
    client.emailDispatch.count({ where: { AND: [sent, DELIVERED] } }),
    client.emailDispatch.count({ where: { AND: [sent, REPORTED] } }),
    client.emailDispatch.count({ where: { AND: [sent, REACHED] } }),
    client.emailDispatch.count({ where: { AND: [sent, OPENED] } }),
    client.emailDispatch.count({ where: { AND: [sent, CLICKED] } }),
  ]);
  return {
    sent: sentCount,
    delivered,
    reported,
    opened,
    clicked,
    deliveryRate: percent(delivered, reported),
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

/**
 * A scope's replies, those received in `receivedAt` when given. Bounces,
 * out-of-office notices and other auto-replies are not replies.
 */
export function countReplies(client: MetricsClient, scope: MetricsScope, receivedAt?: Period): Promise<number> {
  return client.inboundResponse.count({
    where: { AND: [replyWhere(scope), { autoReply: null }, receivedAt ? { receivedAt } : {}] },
  });
}

export type HealthSummary = {
  bounced: number; failed: number; unsubscribed: number; bounceRate: number;
  /** The emails the bounce rate is of: those a delivery report arrived for, and the hard bounces. */
  bounceBase: number;
};

/**
 * A scope's hard bounces, failed send attempts and unsubscribes, those that
 * happened in `period` when given. The bounce rate is of the emails whose
 * outcome is known (bounceBaseWhere), to two decimals.
 */
export async function healthSummary(client: MetricsClient, scope: MetricsScope, period?: Period): Promise<HealthSummary> {
  const sequence = { AND: [scopeWhere(scope), SEQUENCE_SEND] };
  const [bounced, bounceBase, failed, unsubscribed] = await Promise.all([
    countHardBounces(client, scope, period),
    client.emailDispatch.count({ where: { AND: [sequence, bounceBaseWhere(period)] } }),
    client.emailDispatch.count({ where: { AND: [sequence, { status: 'Failed' }, period ? { sentAt: period } : {}] } }),
    client.emailDispatch.count({
      where: { AND: [sequence, { events: { some: { eventType: UNSUBSCRIBE_EVENT, ...(period && { timestamp: period }) } } }] },
    }),
  ]);
  return {
    bounced, failed, unsubscribed, bounceBase,
    bounceRate: percent(bounced, bounceBase, BOUNCE_RATE_DECIMALS),
  };
}

export type StepMetrics = {
  sent: number;
  delivered: number;
  failed: number;
  opened: number;
  clicked: number;
  /** `delivered` of `reported`. */
  deliveryRate: number;
  openRate: number;
  clickRate: number;
  /** Hard bounces (as healthSummary counts them) and emails whose unsubscribe link was used. */
  bounced: number;
  unsubscribed: number;
  /** `bounced` of `bounceBase`, the emails whose outcome is known, as healthSummary counts them; to two decimals. */
  bounceRate: number;
  bounceBase: number;
  unsubscribeRate: number;
  /** Sent emails any delivery report arrived for: the delivery rate's base. With none, `delivered` and its rate say nothing. */
  reported: number;
  /** The leads the sent emails went to, each once however many times it was sent the email. */
  leads: number;
  /** The leads who replied after it (repliedLeadsBy), as a share of `leads`. */
  replied: number;
  replyRate: number;
};

/**
 * Which measures a breakdown loads; the others are left 0. Sent, delivered,
 * failed and how many emails a delivery report arrived for (the delivery
 * rate's base) always load.
 */
export type SendMetricsOptions = {
  /** Opens and clicks. */
  engagement?: boolean;
  /** Hard bounces and unsubscribes. */
  health?: boolean;
  /** Leads emailed, counted once each. */
  leads?: boolean;
  /** Leads who replied; their rate needs `leads` too. */
  replies?: boolean;
};

type SendCounts = {
  sent: number; delivered: number; failed: number; reached: number; opened: number; clicked: number;
  bounced: number; bounceBase: number; unsubscribed: number; reported: number; leads: number; replied: number;
};

const NO_SENDS: SendCounts = {
  sent: 0, delivered: 0, failed: 0, reached: 0, opened: 0, clicked: 0,
  bounced: 0, bounceBase: 0, unsubscribed: 0, reported: 0, leads: 0, replied: 0,
};

/** The column a campaign's sends break down by: the step they were, or the mailbox that sent them. */
type SendGroup = 'stepOrder' | 'senderAccountId';

/** One breakdown row: the campaign, the step or mailbox (null for a send that recorded none) and its counts. */
type SendGroupCounts = { campaignId: string | null; value: number | string | null; counts: SendCounts };

/** The grouping column `d.<group>`, from a fixed list so no caller's text reaches the SQL. */
function groupColumn(group: SendGroup): Prisma.Sql {
  return Prisma.raw(group === 'stepOrder' ? 'd."stepOrder"' : 'd."senderAccountId"');
}

type DistinctLeadRow = { campaignId: string | null; value: number | string | null; leads: number };

/** Per campaign and `group`, the leads its sequence emails ACS accepted went to, each counted once. */
async function distinctLeadsBy(client: MetricsClient, campaignIds: string[], group: SendGroup): Promise<DistinctLeadRow[]> {
  if (campaignIds.length === 0) return [];
  return client.$queryRaw<DistinctLeadRow[]>(Prisma.sql`
    SELECT d."campaignId" AS "campaignId", ${groupColumn(group)} AS "value", COUNT(DISTINCT d."leadId")::int AS "leads"
    FROM "EmailDispatch" d
    WHERE d."campaignId" IN (${Prisma.join(campaignIds)})
      AND d."stepOrder" IS NOT NULL
      AND d."status" = 'Sent'
    GROUP BY d."campaignId", ${groupColumn(group)}
  `);
}

/**
 * Per campaign and `group`, the leads who replied. Each human reply (not a
 * bounce or other automated message, as countReplies counts) goes to the step
 * and mailbox of the latest sequence email of its campaign sent to the lead
 * before it arrived; a failed attempt never reached the lead. A lead counts
 * once per step or mailbox however often it replied, and a reply that arrived
 * before any such email counts nowhere.
 */
async function repliedLeadsBy(client: MetricsClient, campaignIds: string[], group: SendGroup): Promise<DistinctLeadRow[]> {
  if (campaignIds.length === 0) return [];
  return client.$queryRaw<DistinctLeadRow[]>(Prisma.sql`
    SELECT r."campaignId" AS "campaignId", ${groupColumn(group)} AS "value", COUNT(DISTINCT r."leadId")::int AS "leads"
    FROM "InboundResponse" r
    CROSS JOIN LATERAL (
      SELECT e."stepOrder", e."senderAccountId"
      FROM "EmailDispatch" e
      WHERE e."campaignId" = r."campaignId"
        AND e."leadId" = r."leadId"
        AND e."stepOrder" IS NOT NULL
        AND e."status" <> 'Failed'
        AND e."sentAt" <= r."receivedAt"
      ORDER BY e."sentAt" DESC, e."id" DESC
      LIMIT 1
    ) d
    WHERE r."campaignId" IN (${Prisma.join(campaignIds)})
      AND r."autoReply" IS NULL
    GROUP BY r."campaignId", ${groupColumn(group)}
  `);
}

/**
 * The sequence sends of `campaignIds` broken down by campaign and `group`,
 * with the same definitions as the campaign totals: sent, delivered and
 * failed attempts, how many a delivery report arrived for, and the measures
 * `options` asks for.
 */
async function sendCountsBy(
  client: MetricsClient,
  campaignIds: string[],
  group: SendGroup,
  options: SendMetricsOptions,
): Promise<Map<string, SendGroupCounts>> {
  const sends: Prisma.EmailDispatchWhereInput = { AND: [{ campaignId: { in: campaignIds } }, SEQUENCE_SEND] };
  const sent: Prisma.EmailDispatchWhereInput = { AND: [sends, SENT] };
  const countBy = (where: Prisma.EmailDispatchWhereInput) =>
    client.emailDispatch.groupBy({ by: ['campaignId', group], where, _count: { id: true } });
  const countIf = (wanted: boolean | undefined, where: Prisma.EmailDispatchWhereInput) =>
    wanted ? countBy(where) : Promise.resolve([]);

  const [byStatus, delivered, reported, reached, opened, clicked, bounced, bounceBase, unsubscribed, leads, replied] = await Promise.all([
    client.emailDispatch.groupBy({ by: ['campaignId', group, 'status'], where: sends, _count: { id: true } }),
    countBy({ AND: [sent, DELIVERED] }),
    // The delivery rate's base.
    countBy({ AND: [sent, REPORTED] }),
    countIf(options.engagement, { AND: [sent, REACHED] }),
    countIf(options.engagement, { AND: [sent, OPENED] }),
    countIf(options.engagement, { AND: [sent, CLICKED] }),
    // As healthSummary: hard bounces, over the emails whose outcome is known.
    countIf(options.health, { AND: [sends, hardBounceWhere()] }),
    countIf(options.health, { AND: [sends, bounceBaseWhere()] }),
    countIf(options.health, { AND: [sends, { events: { some: { eventType: UNSUBSCRIBE_EVENT } } }] }),
    options.leads ? distinctLeadsBy(client, campaignIds, group) : Promise.resolve([]),
    options.replies ? repliedLeadsBy(client, campaignIds, group) : Promise.resolve([]),
  ]);

  const groups = new Map<string, SendGroupCounts>();
  const at = (campaignId: string | null, value: number | string | null): SendCounts => {
    const key = `${campaignId}:${value}`;
    let entry = groups.get(key);
    if (!entry) {
      entry = { campaignId, value, counts: { ...NO_SENDS } };
      groups.set(key, entry);
    }
    return entry.counts;
  };
  type GroupRow = { campaignId: string | null; stepOrder?: number | null; senderAccountId?: string | null; _count: { id: number } };
  const add = (field: keyof SendCounts, rows: GroupRow[]) => {
    for (const row of rows) at(row.campaignId, row[group] ?? null)[field] += row._count.id;
  };
  for (const row of byStatus as Array<GroupRow & { status: string }>) {
    if (row.status === 'Sent') at(row.campaignId, row[group] ?? null).sent += row._count.id;
    else if (row.status === 'Failed') at(row.campaignId, row[group] ?? null).failed += row._count.id;
  }
  add('delivered', delivered as GroupRow[]);
  add('reported', reported as GroupRow[]);
  add('reached', reached as GroupRow[]);
  add('opened', opened as GroupRow[]);
  add('clicked', clicked as GroupRow[]);
  add('bounced', bounced as GroupRow[]);
  add('bounceBase', bounceBase as GroupRow[]);
  add('unsubscribed', unsubscribed as GroupRow[]);
  for (const row of leads) at(row.campaignId, row.value ?? null).leads += Number(row.leads);
  for (const row of replied) at(row.campaignId, row.value ?? null).replied += Number(row.leads);
  return groups;
}

/** A breakdown row's counts with their rates. */
function sendMetrics(c: SendCounts = NO_SENDS): StepMetrics {
  return {
    sent: c.sent,
    delivered: c.delivered,
    failed: c.failed,
    opened: c.opened,
    clicked: c.clicked,
    deliveryRate: percent(c.delivered, c.reported),
    openRate: percent(c.opened, c.reached),
    clickRate: percent(c.clicked, c.reached),
    bounced: c.bounced,
    unsubscribed: c.unsubscribed,
    bounceRate: percent(c.bounced, c.bounceBase, BOUNCE_RATE_DECIMALS),
    bounceBase: c.bounceBase,
    unsubscribeRate: percent(c.unsubscribed, c.sent),
    reported: c.reported,
    leads: c.leads,
    replied: c.replied,
    replyRate: percent(c.replied, c.leads),
  };
}

/**
 * Per-step sends of each of `campaignIds`, with the same definitions as the
 * campaign totals: sent, delivered and failed attempts and how many a
 * delivery report arrived for always, and the measures `options` asks for
 * (left 0 without them). Returns a lookup by campaign and step.
 */
export async function stepMetrics(
  client: MetricsClient,
  campaignIds: string[],
  options: SendMetricsOptions = {},
): Promise<(campaignId: string, stepOrder: number) => StepMetrics> {
  const groups = await sendCountsBy(client, campaignIds, 'stepOrder', options);
  return (campaignId, stepOrder) => sendMetrics(groups.get(`${campaignId}:${stepOrder}`)?.counts);
}

/** A campaign's sends from one mailbox; `senderAccountId` is null for sends that recorded none. */
export type MailboxMetrics = StepMetrics & { senderAccountId: string | null };

/**
 * A campaign's sequence sends by the mailbox that sent them, with every
 * measure stepMetrics has, most emails sent first. Sends that recorded no
 * mailbox (made before dispatches recorded one, or from a mailbox since
 * deleted) come as a row of their own rather than being put on one.
 */
export async function mailboxMetrics(client: MetricsClient, campaignId: string): Promise<MailboxMetrics[]> {
  const groups = await sendCountsBy(client, [campaignId], 'senderAccountId', { engagement: true, health: true, leads: true, replies: true });
  return [...groups.values()]
    .map(({ value, counts }) => ({ senderAccountId: typeof value === 'string' ? value : null, ...sendMetrics(counts) }))
    .sort((a, b) => b.sent - a.sent || b.failed - a.failed);
}

export type DeliveryBreakdown = {
  /** Sequence emails ACS accepted. */
  accepted: number;
  /** Of those, the ones a delivery report arrived for. */
  reported: number;
  delivered: number;
  /** Distribution lists expanded; each member's own report is counted apart. */
  expanded: number;
  /** FilteredSpam: the recipient's filtering rejected the email as spam. */
  spam: number;
  /** Quarantined: the recipient's filtering held the email. */
  quarantined: number;
  softBounced: number;
  hardBounced: number;
  /** Any other reported status. */
  otherReported: number;
  noReport: number;
};

/**
 * What delivery reports (lib/deliveryReport) said about a scope's sequence
 * emails ACS accepted: a bounce by its type, else the report's status. Emails
 * no report has arrived for are counted apart, so a scope with no reports at
 * all shows that rather than nothing delivered.
 */
export async function deliveryBreakdown(client: MetricsClient, scope: MetricsScope): Promise<DeliveryBreakdown> {
  const rows = await client.emailDispatch.groupBy({
    by: ['deliveryStatus', 'bounceType'],
    where: sentWhere(scope),
    _count: { id: true },
  });
  const breakdown: DeliveryBreakdown = {
    accepted: 0, reported: 0, delivered: 0, expanded: 0, spam: 0, quarantined: 0,
    softBounced: 0, hardBounced: 0, otherReported: 0, noReport: 0,
  };
  for (const row of rows) {
    const count = row._count.id;
    breakdown.accepted += count;
    if (row.bounceType === 'hard') breakdown.hardBounced += count;
    else if (row.bounceType === 'soft') breakdown.softBounced += count;
    else if (row.deliveryStatus === null) breakdown.noReport += count;
    else if (row.deliveryStatus === 'Delivered') breakdown.delivered += count;
    else if (row.deliveryStatus === 'Expanded') breakdown.expanded += count;
    else if (row.deliveryStatus === 'FilteredSpam') breakdown.spam += count;
    else if (row.deliveryStatus === 'Quarantined') breakdown.quarantined += count;
    else breakdown.otherReported += count;
  }
  breakdown.reported = breakdown.accepted - breakdown.noReport;
  return breakdown;
}

export type CampaignLeadTotals = {
  /** Leads ACS accepted at least one of the campaign's sequence emails for. */
  contacted: number;
  /**
   * Of those, the leads with an email sendSummary counts as opened (and as
   * clicked), each once however many of their emails were: the people the
   * opened and clicked emails came from.
   */
  opened: number;
  clicked: number;
  /** Leads who sent the campaign a human reply (the replies countReplies counts), each once. */
  replied: number;
  /** When its first and latest accepted sequence emails were sent; null before any. */
  firstSentAt: Date | null;
  lastSentAt: Date | null;
};

type LeadTotalsRow = {
  contacted: number; opened: number; clicked: number; replied: number; firstSentAt: Date | null; lastSentAt: Date | null;
};

/**
 * A campaign's lead-level totals, in one query. Each accepted sequence email
 * is joined to a person's opens and clicks on it (not the machine hits
 * lib/botFilter recorded), which repeats the email once per hit but leaves the
 * counts of distinct leads, and the first and latest send, as they are.
 */
export async function campaignLeadTotals(client: MetricsClient, campaignId: string): Promise<CampaignLeadTotals> {
  const [row] = await client.$queryRaw<LeadTotalsRow[]>(Prisma.sql`
    SELECT
      (SELECT COUNT(DISTINCT r."leadId") FROM "InboundResponse" r
        WHERE r."campaignId" = ${campaignId} AND r."autoReply" IS NULL)::int AS "replied",
      t."contacted", t."opened", t."clicked", t."firstSentAt", t."lastSentAt"
    FROM (
      SELECT COUNT(DISTINCT d."leadId")::int AS "contacted",
             COUNT(DISTINCT d."leadId") FILTER (WHERE e."eventType" IS NOT NULL)::int AS "opened",
             COUNT(DISTINCT d."leadId") FILTER (WHERE e."eventType" = ${CLICK_EVENT})::int AS "clicked",
             MIN(d."sentAt") AS "firstSentAt", MAX(d."sentAt") AS "lastSentAt"
      FROM "EmailDispatch" d
      LEFT JOIN "EmailEvent" e
        ON e."messageId" = d."messageId" AND e."eventType" IN (${Prisma.join([OPEN_EVENT, CLICK_EVENT])})
      WHERE d."campaignId" = ${campaignId} AND d."stepOrder" IS NOT NULL AND d."status" = 'Sent'
    ) t
  `);
  return {
    contacted: Number(row?.contacted ?? 0),
    opened: Number(row?.opened ?? 0),
    clicked: Number(row?.clicked ?? 0),
    replied: Number(row?.replied ?? 0),
    firstSentAt: row?.firstSentAt ?? null,
    lastSentAt: row?.lastSentAt ?? null,
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
 * replies received, and meetings booked are leads. Delivered and Replied only
 * when given.
 */
export function engagementFunnel(counts: {
  sent: number;
  delivered?: number;
  opened: number;
  clicked: number;
  replies?: number;
  meetingsBooked: number;
}): FunnelStage[] {
  return [
    { name: 'Sent', value: counts.sent, unit: 'Emails' },
    ...(counts.delivered === undefined ? [] : [{ name: 'Delivered', value: counts.delivered, unit: 'Emails' as const }]),
    { name: 'Opened', value: counts.opened, unit: 'Emails' },
    { name: 'Clicked', value: counts.clicked, unit: 'Emails' },
    ...(counts.replies === undefined ? [] : [{ name: 'Replied', value: counts.replies, unit: 'Replies' as const }]),
    { name: 'Meeting Booked', value: counts.meetingsBooked, unit: 'Leads' },
  ];
}
