/**
 * A campaign can skip the leads other campaigns have emailed. Its
 * skipLeadsEmailedBy names those campaigns, and a lead one of them has emailed
 * gets nothing from it: the lead's enrollment is marked Skipped, which keeps
 * it counted on the campaign's pages and out of the send engine (Active only).
 *
 * Leads are marked when the list is saved, when the campaign is made Active,
 * when they join its audience group, and by the send engine right before each
 * send, so a lead a named campaign emails later is skipped from then on,
 * whatever step it had reached here. It works one way: the named campaigns go
 * on sending to the lead.
 *
 * A Skipped enrollment keeps its step and send date. Taking a campaign out of
 * the list puts the leads no remaining campaign covers back in the sequence
 * where they were (restoreSkippedLeads). A named campaign can't be deleted
 * (skippingCampaignsError): its emails would no longer count as its own, and
 * the leads skipped for them would be put back by the next save.
 */

import type { Prisma } from '@prisma/client';

/** Enrollment status of a lead the campaign skips because a campaign it names has emailed the lead. */
export const SKIPPED_ENROLLMENT_STATUS = 'Skipped';

/** Most campaigns one list names. */
export const MAX_SKIP_CAMPAIGNS = 50;

type EnrollmentClient = Pick<Prisma.TransactionClient, 'campaignEnrollment'>;
type CampaignClient = Pick<Prisma.TransactionClient, 'campaign'>;

/** A stored list as read back: [] for a row loaded without the column. */
export function storedSkipCampaignIds(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
}

/**
 * Reads the list a save sends for campaign `campaignId` into the list to
 * store: campaign IDs, duplicates dropped, in the order given. A campaign
 * can't name itself.
 */
export function parseSkipCampaignIds(
  value: unknown,
  campaignId: string,
): { ids: string[]; error: null } | { ids: null; error: string } {
  if (!Array.isArray(value) || !value.every((id) => typeof id === 'string' && id.trim() !== '')) {
    return { ids: null, error: 'skipLeadsEmailedBy must be a list of campaign IDs.' };
  }
  const ids = [...new Set(value as string[])];
  if (ids.includes(campaignId)) {
    return { ids: null, error: 'A campaign cannot skip the leads it emailed itself. Take it out of Skip Leads Emailed By.' };
  }
  if (ids.length > MAX_SKIP_CAMPAIGNS) {
    return { ids: null, error: `Skip Leads Emailed By takes at most ${MAX_SKIP_CAMPAIGNS} campaigns.` };
  }
  return { ids, error: null };
}

/**
 * Why `campaignIds` may not be added to a list by this session, or null: each
 * must be a campaign that exists and that the session may see (its own, or
 * any for an admin).
 */
export async function skipCampaignsError(
  client: CampaignClient,
  session: { id: string; role: string },
  campaignIds: string[],
): Promise<string | null> {
  if (campaignIds.length === 0) return null;
  const found = await client.campaign.findMany({
    where: { id: { in: campaignIds } },
    select: { id: true, userId: true },
  });
  const allowed = found.filter((campaign) => session.role === 'ADMIN' || campaign.userId === session.id);
  return allowed.length === campaignIds.length
    ? null
    : 'Skip Leads Emailed By names a campaign that does not exist or is not yours.';
}

/**
 * The dispatches that say one of `campaignIds` emailed a lead: a sequence
 * email Azure accepted, or one in flight or never confirmed, which may have
 * gone out. A Failed attempt sent nothing, and Unibox replies have no step.
 */
export function emailedByWhere(campaignIds: string[]): Prisma.EmailDispatchWhereInput {
  return { campaignId: { in: campaignIds }, stepOrder: { not: null }, status: { in: ['Sent', 'Sending', 'Unknown'] } };
}

/**
 * Marks Skipped the Active enrollments of `campaignId` whose lead one of
 * `skipCampaignIds` has emailed, only those of `leadIds` when given. The
 * enrollment keeps its step and send date. Returns how many were marked.
 */
export async function skipEmailedLeads(
  client: EnrollmentClient,
  campaignId: string,
  skipCampaignIds: string[],
  leadIds?: string[],
): Promise<number> {
  if (skipCampaignIds.length === 0 || leadIds?.length === 0) return 0;
  const { count } = await client.campaignEnrollment.updateMany({
    where: {
      campaignId,
      status: 'Active',
      ...(leadIds && { leadId: { in: leadIds } }),
      lead: { dispatches: { some: emailedByWhere(skipCampaignIds) } },
    },
    data: { status: SKIPPED_ENROLLMENT_STATUS },
  });
  return count;
}

/**
 * Ends the skip of the Skipped enrollments of `campaignId` whose lead none of
 * `skipCampaignIds` has emailed: every one of them when the list is empty.
 * Those whose lead is still in the campaign's `audience` (lib/campaignCohort
 * cohortLeadWhere) go back in the sequence at the step and send date they had,
 * so one that was due is due again at once. A lead that left the audience
 * while skipped is Paused instead, as a lead that leaves it is. Returns how
 * many went back in the sequence.
 */
export async function restoreSkippedLeads(
  client: EnrollmentClient,
  campaignId: string,
  skipCampaignIds: string[],
  audience: Prisma.LeadWhereInput,
  now: Date = new Date(),
): Promise<number> {
  const notEmailed: Prisma.LeadWhereInput = skipCampaignIds.length > 0
    ? { dispatches: { none: emailedByWhere(skipCampaignIds) } }
    : {};
  const skipped = { campaignId, status: SKIPPED_ENROLLMENT_STATUS };
  const backInSequence = { ...skipped, lead: { AND: [notEmailed, audience] } };
  await client.campaignEnrollment.updateMany({
    where: { ...backInSequence, nextActionDate: null },
    data: { nextActionDate: now },
  });
  const { count } = await client.campaignEnrollment.updateMany({
    where: backInSequence,
    data: { status: 'Active' },
  });
  // What is left has no campaign to be skipped for and is no longer in the audience.
  await client.campaignEnrollment.updateMany({
    where: { ...skipped, lead: notEmailed },
    data: { status: 'Paused' },
  });
  return count;
}

/** A campaign a list names, with how many of the skipping campaign's leads are skipped for its emails. */
export type SkipSource = {
  id: string;
  /** Null when the session's list of campaigns has no such campaign any more. */
  name: string | null;
  leads: number;
};

/**
 * The campaigns `skipCampaignIds` names, in that order, each with how many of
 * `campaignId`'s Skipped leads it has emailed. A lead two of them emailed
 * counts under both.
 */
export async function skipSources(
  client: EnrollmentClient & CampaignClient,
  campaignId: string,
  skipCampaignIds: string[],
): Promise<SkipSource[]> {
  if (skipCampaignIds.length === 0) return [];
  const campaigns = await client.campaign.findMany({
    where: { id: { in: skipCampaignIds } },
    select: { id: true, name: true },
  });
  return Promise.all(skipCampaignIds.map(async (id) => ({
    id,
    name: campaigns.find((campaign) => campaign.id === id)?.name ?? null,
    leads: await client.campaignEnrollment.count({
      where: { campaignId, status: SKIPPED_ENROLLMENT_STATUS, lead: { dispatches: { some: emailedByWhere([id]) } } },
    }),
  })));
}

function quotedList(names: string[]): string {
  const quoted = names.map((name) => `"${name}"`);
  return quoted.length <= 1 ? quoted.join('') : `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`;
}

/**
 * Why campaign `campaignId` can't be deleted, or null: the campaigns that skip
 * the leads it emailed, by name. Once it is deleted its emails are no longer
 * its own (EmailDispatch.campaignId is set null), so those leads would go back
 * in the other campaigns' sequences at their next save. Non-admins get only
 * the names of their own campaigns.
 */
export async function skippingCampaignsError(
  client: CampaignClient,
  session: { id: string; role: string },
  campaignId: string,
): Promise<string | null> {
  const skipping = await client.campaign.findMany({
    where: { skipLeadsEmailedBy: { has: campaignId } },
    select: { name: true, userId: true },
    orderBy: { name: 'asc' },
  });
  if (skipping.length === 0) return null;
  const names = skipping
    .filter((campaign) => session.role === 'ADMIN' || campaign.userId === session.id)
    .map((campaign) => campaign.name);
  const hidden = skipping.length - names.length;
  const who = names.length === 0
    ? `${hidden} other ${hidden === 1 ? 'campaign skips' : 'campaigns skip'}`
    : `${quotedList(names)}${hidden > 0 ? ` and ${hidden} more` : ''} ${skipping.length === 1 ? 'skips' : 'skip'}`;
  return `This campaign can't be deleted: ${who} the leads it emailed. Take it out of Skip Leads Emailed By on the Audience tab of ${skipping.length === 1 ? 'that campaign' : 'those campaigns'} first.`;
}
