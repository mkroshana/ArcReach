import type { PrismaClient } from '@prisma/client';
import { cohortGroupId, cohortLeadWhere } from './campaignCohort';
import { findEnrollableLeadIds } from './sendEligibility';

/**
 * Rules scripts/backfill-group-enrollments.ts uses to find the leads a
 * campaign whose audience is a lead group never enrolled. A lead that joins a
 * group is enrolled in the campaigns targeting it (enrollGroupJoiners), but
 * before M25 (2026-09-30) in none of them and until 2026-10-01 only in the
 * Active and Draft ones, and a campaign's audience is synced again only when
 * a save changes it, never when the campaign is resumed. Group memberships
 * carry no date, so a lead missed that way looks like any other lead of the
 * group without an enrollment: every such lead that may be enrolled counts, in
 * campaigns of every status.
 */

/** A campaign whose audience is a lead group, and the leads of the group it never enrolled. */
export type GroupEnrollmentGap = {
  campaignId: string;
  name: string;
  status: string;
  /** The campaign's audienceCohort: the group's id, or the legacy `group_<id>`. */
  audienceCohort: string;
  groupId: string;
  /** The group's name, or null when no group has that id. */
  groupName: string | null;
  /**
   * A save's audience sync has not finished (cohortSyncRequestedAt is set), so
   * the campaign's enrollments are still changing; its next save finishes them.
   */
  syncPending: boolean;
  /** How many leads of the group may be enrolled (findEnrollableLeadIds). */
  enrollable: number;
  /**
   * Those of them with no enrollment in the campaign that it never emailed and
   * never had a reply from: the leads to enroll.
   */
  toEnroll: string[];
  /**
   * How many of them have no enrollment but were emailed by the campaign or
   * replied to it. They are left alone, so no lead is sent step 1 twice.
   */
  contacted: number;
};

/**
 * The GroupEnrollmentGap of every campaign whose audience is a lead group,
 * ordered by name, or only of those of `campaignIds` that are. It only reads.
 */
export async function findGroupEnrollmentGaps(
  client: PrismaClient,
  campaignIds?: string[],
): Promise<GroupEnrollmentGap[]> {
  const campaigns = await client.campaign.findMany({
    where: { audienceCohort: { notIn: ['Valid', 'Unverified'] }, ...(campaignIds && { id: { in: campaignIds } }) },
    select: { id: true, name: true, status: true, audienceCohort: true, cohortSyncRequestedAt: true },
    orderBy: { name: 'asc' },
  });
  const groups = await client.leadGroup.findMany({
    where: { id: { in: campaigns.map((campaign) => cohortGroupId(campaign.audienceCohort)) } },
    select: { id: true, name: true },
  });
  const groupNames = new Map(groups.map((group) => [group.id, group.name]));

  const gaps: GroupEnrollmentGap[] = [];
  for (const campaign of campaigns) {
    const enrollable = await findEnrollableLeadIds(client, cohortLeadWhere(campaign.audienceCohort));
    const enrollments = await client.campaignEnrollment.findMany({
      where: { campaignId: campaign.id },
      select: { leadId: true },
    });
    const dispatches = await client.emailDispatch.findMany({
      where: { campaignId: campaign.id },
      select: { leadId: true },
      distinct: ['leadId'],
    });
    const replies = await client.inboundResponse.findMany({
      where: { campaignId: campaign.id },
      select: { leadId: true },
      distinct: ['leadId'],
    });
    const enrolled = new Set(enrollments.map((enrollment) => enrollment.leadId));
    const contacted = new Set<string | null>([...dispatches, ...replies].map((row) => row.leadId));
    const notEnrolled = enrollable.filter((leadId) => !enrolled.has(leadId));
    const groupId = cohortGroupId(campaign.audienceCohort);
    gaps.push({
      campaignId: campaign.id,
      name: campaign.name,
      status: campaign.status,
      audienceCohort: campaign.audienceCohort,
      groupId,
      groupName: groupNames.get(groupId) ?? null,
      syncPending: campaign.cohortSyncRequestedAt != null,
      enrollable: enrollable.length,
      toEnroll: notEnrolled.filter((leadId) => !contacted.has(leadId)),
      contacted: notEnrolled.filter((leadId) => contacted.has(leadId)).length,
    });
  }
  return gaps;
}
