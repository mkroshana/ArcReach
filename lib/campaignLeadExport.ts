/**
 * The leads of a campaign worth taking further, for the campaign page's Export
 * Leads card: a list to export as CSV or to add to a lead group.
 *
 * - delivered: at least one of the campaign's sequence emails was delivered to
 *   the lead (a delivery report said Delivered and none bounced it since), as
 *   the Delivered figure counts emails.
 * - engaged: the lead replied to the campaign (a human reply, as countReplies
 *   counts), or opened or clicked one of its emails (a person's open or click,
 *   not the machine hits lib/botFilter recorded), as Lead Progress counts leads.
 *
 * Either list holds only leads that may still be emailed (sendableLeadWhere
 * and not on the suppression list): a lead that hard-bounced, unsubscribed or
 * was archived since is left out, so an opt-out never reaches a new list.
 */

import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from './db';
import { enrollGroupJoiners, cohortGroupId } from './campaignCohort';
import { CLICK_EVENT, OPEN_EVENT, SEQUENCE_SEND } from './engagementMetrics';
import { normalizeEmail } from './leadEmail';
import { sendableLeadWhere } from './sendEligibility';
import { suppressionReasons } from './suppression';

export const LEAD_SETS = ['delivered', 'engaged'] as const;
export type LeadSet = (typeof LEAD_SETS)[number];

export function isLeadSet(value: unknown): value is LeadSet {
  return typeof value === 'string' && (LEAD_SETS as readonly string[]).includes(value);
}

/** Memberships one write adds, and leads one enrollment pass takes: far inside Postgres's 32767 bind parameters. */
export const GROUP_ADD_BATCH = 2000;

type ExportClient = Pick<PrismaClient, 'lead' | 'emailDispatch' | 'inboundResponse' | 'suppressedEmail'>;

/** The campaign's sequence emails Azure accepted. */
function sentEmail(campaignId: string): Prisma.EmailDispatchWhereInput {
  return { campaignId, ...SEQUENCE_SEND, status: 'Sent' };
}

/** Of those, the ones delivered: a report said Delivered and no later one bounced it. */
function deliveredEmail(campaignId: string): Prisma.EmailDispatchWhereInput {
  return { ...sentEmail(campaignId), deliveryStatus: 'Delivered', bounceType: null };
}

/** Of those, the ones a person opened or clicked (a click proves the open). */
function openedEmail(campaignId: string): Prisma.EmailDispatchWhereInput {
  return { ...sentEmail(campaignId), events: { some: { eventType: { in: [OPEN_EVENT, CLICK_EVENT] } } } };
}

function clickedEmail(campaignId: string): Prisma.EmailDispatchWhereInput {
  return { ...sentEmail(campaignId), events: { some: { eventType: CLICK_EVENT } } };
}

/** The campaign's human replies: bounces, out-of-office notices and other auto-replies are not replies. */
function humanReply(campaignId: string): Prisma.InboundResponseWhereInput {
  return { campaignId, autoReply: null };
}

/** Lead filter for the leads of `set`, before those that may no longer be emailed are left out. */
export function leadSetWhere(campaignId: string, set: LeadSet): Prisma.LeadWhereInput {
  if (set === 'delivered') return { dispatches: { some: deliveredEmail(campaignId) } };
  return { OR: [{ replies: { some: humanReply(campaignId) } }, { dispatches: { some: openedEmail(campaignId) } }] };
}

type SetLead = { id: string; email: string; name: string | null; company: string | null; jobTitle: string | null; status: string };

/** The leads of `set` that may still be emailed, in address order. */
async function leadsOfSet(client: ExportClient, campaignId: string, set: LeadSet): Promise<SetLead[]> {
  const leads = await client.lead.findMany({
    where: { AND: [leadSetWhere(campaignId, set), sendableLeadWhere()] },
    select: { id: true, email: true, name: true, company: true, jobTitle: true, status: true },
    orderBy: { email: 'asc' },
  });
  const suppressed = await suppressionReasons(client, leads.map((lead) => lead.email));
  return suppressed.size === 0 ? leads : leads.filter((lead) => !suppressed.has(normalizeEmail(lead.email)));
}

/** How many leads each list holds. */
export async function leadSetCounts(client: ExportClient, campaignId: string): Promise<Record<LeadSet, number>> {
  const [delivered, engaged] = await Promise.all([
    leadsOfSet(client, campaignId, 'delivered'),
    leadsOfSet(client, campaignId, 'engaged'),
  ]);
  return { delivered: delivered.length, engaged: engaged.length };
}

/** A lead as the export lists it, with what the campaign knows of it. */
export type ExportedLead = {
  email: string;
  name: string;
  company: string;
  jobTitle: string;
  status: string;
  /** How many of the campaign's emails were delivered to the lead. */
  delivered: number;
  opened: boolean;
  clicked: boolean;
  replied: boolean;
};

async function leadIdsWith(client: ExportClient, where: Prisma.EmailDispatchWhereInput): Promise<Set<string>> {
  const rows = await client.emailDispatch.findMany({ where, select: { leadId: true }, distinct: ['leadId'] });
  return new Set(rows.flatMap((row) => (row.leadId ? [row.leadId] : [])));
}

/** The leads of `set` with their delivered emails and engagement in this campaign, in address order. */
export async function exportLeadSet(client: ExportClient, campaignId: string, set: LeadSet): Promise<ExportedLead[]> {
  const leads = await leadsOfSet(client, campaignId, set);
  if (leads.length === 0) return [];
  // Counted over the whole campaign rather than by lead id, so a long list never meets the bind parameter limit.
  const [deliveries, opened, clicked, replies] = await Promise.all([
    client.emailDispatch.groupBy({ by: ['leadId'], where: deliveredEmail(campaignId), _count: { id: true } }),
    leadIdsWith(client, openedEmail(campaignId)),
    leadIdsWith(client, clickedEmail(campaignId)),
    client.inboundResponse.findMany({ where: humanReply(campaignId), select: { leadId: true }, distinct: ['leadId'] }),
  ]);
  const deliveredCount = new Map(deliveries.map((row) => [row.leadId, row._count.id]));
  const replied = new Set(replies.map((row) => row.leadId));
  return leads.map((lead) => ({
    email: lead.email,
    name: lead.name ?? '',
    company: lead.company ?? '',
    jobTitle: lead.jobTitle ?? '',
    status: lead.status,
    delivered: deliveredCount.get(lead.id) ?? 0,
    opened: opened.has(lead.id),
    clicked: clicked.has(lead.id),
    replied: replied.has(lead.id),
  }));
}

/** How many campaigns target each lead group (their audienceCohort), by group id: a lead added to the group is enrolled in them. */
export async function campaignsByGroup(client: Pick<PrismaClient, 'campaign'>): Promise<Record<string, number>> {
  const campaigns = await client.campaign.findMany({
    where: { audienceCohort: { notIn: ['Valid', 'Unverified'] } },
    select: { audienceCohort: true },
  });
  const counts: Record<string, number> = {};
  for (const { audienceCohort } of campaigns) {
    const groupId = cohortGroupId(audienceCohort);
    counts[groupId] = (counts[groupId] ?? 0) + 1;
  }
  return counts;
}

export class GroupAddError extends Error {
  constructor(message: string, readonly status: 400 | 404) {
    super(message);
  }
}

export type GroupAddResult = {
  group: { id: string; name: string };
  /** Whether the group was made for this. */
  created: boolean;
  /** Leads of the list that joined the group, and those already in it. */
  added: number;
  alreadyIn: number;
};

/**
 * Adds the leads of `set` to a lead group: an existing one (`groupId`) or a new
 * one named `groupName`, which must not be taken. A lead already in the group
 * stays as it is. Like every way into a group, joining enrolls the lead in the
 * campaigns that target the group (enrollGroupJoiners). The leads join in
 * batches of GROUP_ADD_BATCH, each with its enrollments in one transaction, so
 * a list of any size stays inside the transaction time limit; a batch that
 * fails leaves the earlier ones in place, and running it again adds the rest.
 */
export async function addLeadSetToGroup(
  campaignId: string,
  set: LeadSet,
  target: { groupId?: unknown; groupName?: unknown },
): Promise<GroupAddResult> {
  const name = typeof target.groupName === 'string' ? target.groupName.trim() : '';
  const groupId = typeof target.groupId === 'string' ? target.groupId : '';
  if ((groupId === '') === (name === '')) {
    throw new GroupAddError('Choose an existing lead group or name a new one.', 400);
  }

  let group: { id: string; name: string };
  let created = false;
  if (groupId) {
    const existing = await prisma.leadGroup.findUnique({ where: { id: groupId }, select: { id: true, name: true } });
    if (!existing) throw new GroupAddError('That lead group no longer exists.', 404);
    group = existing;
  } else {
    const taken = await prisma.leadGroup.findFirst({ where: { name }, select: { id: true } });
    if (taken) throw new GroupAddError('A lead group with this name already exists. Choose it from the list instead.', 400);
    group = await prisma.leadGroup.create({ data: { name }, select: { id: true, name: true } });
    created = true;
  }

  const leads = await leadsOfSet(prisma, campaignId, set);
  const members = await prisma.leadGroupMembership.findMany({ where: { groupId: group.id }, select: { leadId: true } });
  const alreadyMembers = new Set(members.map((member) => member.leadId));
  const joining = leads.filter((lead) => !alreadyMembers.has(lead.id)).map((lead) => lead.id);

  for (let i = 0; i < joining.length; i += GROUP_ADD_BATCH) {
    const batch = joining.slice(i, i + GROUP_ADD_BATCH);
    await prisma.$transaction(async (tx) => {
      await tx.leadGroupMembership.createMany({
        data: batch.map((leadId) => ({ leadId, groupId: group.id })),
        skipDuplicates: true,
      });
      await enrollGroupJoiners(tx, batch, [group.id]);
    }, { timeout: 30000 });
  }

  return { group, created, added: joining.length, alreadyIn: leads.length - joining.length };
}
