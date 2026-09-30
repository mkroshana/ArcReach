import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { sameCampaignVersion } from '@/lib/campaignVersion';
import { findEnrollableLeadIds } from '@/lib/sendEligibility';

/**
 * A campaign's audienceCohort names the leads it enrolls: every non-archived
 * 'Valid' lead, every non-archived 'Unverified' lead, or the non-archived
 * members of a lead group (stored as the group ID, or the legacy `group_<id>`).
 */

/** Enrollment status for a lead that left the audience after this campaign emailed it. */
export const REMOVED_ENROLLMENT_STATUS = 'Removed';

function cohortGroupId(cohort: string): string {
  return cohort.startsWith('group_') ? cohort.slice('group_'.length) : cohort;
}

/** The audienceCohort values that target one of `groupIds`: the group ID or the legacy `group_<id>`. */
function groupCohorts(groupIds: string[]): string[] {
  return groupIds.flatMap((groupId) => [groupId, `group_${groupId}`]);
}

/** Lead filter for the leads `cohort` enrolls. */
export function cohortLeadWhere(cohort: string): Prisma.LeadWhereInput {
  if (cohort === 'Valid' || cohort === 'Unverified') {
    return { validationStatus: cohort, isArchived: false };
  }
  return { isArchived: false, groups: { some: { groupId: cohortGroupId(cohort) } } };
}

/** Error message unless `cohort` is 'Valid', 'Unverified' or an existing lead group ID. */
export async function checkAudienceCohort(cohort: unknown): Promise<string | null> {
  if (cohort === 'Valid' || cohort === 'Unverified') return null;
  if (typeof cohort === 'string' && cohort !== '') {
    const group = await prisma.leadGroup.findUnique({
      where: { id: cohortGroupId(cohort) },
      select: { id: true },
    });
    if (group) return null;
  }
  return 'audienceCohort must be Valid, Unverified or an existing lead group ID.';
}

/**
 * Most enrollments one sync batch writes. Each batch is its own short
 * transaction, far inside Prisma's 5s interactive-transaction default even for
 * a cohort of tens of thousands of leads, and its id lists and inserted rows
 * (6 values each, with the generated id) stay well under Postgres's 32767
 * bind parameters.
 */
export const COHORT_SYNC_BATCH = 2000;

/**
 * Runs `write` in a short transaction that first locks the campaign row, and
 * only while its cohortSyncRequestedAt still names `request`. A later save
 * that changes the audience or runs the sync again sets a new one, so it waits
 * for a batch in flight and then stops this sync from writing more. The lock
 * (FOR NO KEY UPDATE) is the one a save's update takes, so enrollments other
 * writers insert for the campaign never wait for it. Returns false, without
 * writing, once the sync is no longer `request`'s.
 */
async function writeSyncBatch(
  campaignId: string,
  request: Date,
  write: (tx: Prisma.TransactionClient, campaign: { updatedAt: Date }) => Promise<unknown>,
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const [campaign] = await tx.$queryRaw<{ cohortSyncRequestedAt: Date | null; updatedAt: Date }[]>(Prisma.sql`
      SELECT "cohortSyncRequestedAt", "updatedAt" FROM "Campaign" WHERE "id" = ${campaignId} FOR NO KEY UPDATE
    `);
    if (!campaign || !sameCampaignVersion(campaign.cohortSyncRequestedAt, request)) return false;
    await write(tx, campaign);
    return true;
  });
}

/**
 * Bring a campaign's enrollments in line with `cohort`, the audience that the
 * save with version `request` stored along with cohortSyncRequestedAt. The
 * cohort's leads that may be enrolled (findEnrollableLeadIds: not archived,
 * unsubscribed, bounced, invalid or on the suppression list) and are new to it
 * are enrolled Active at step 1. For a lead that left the cohort or may no
 * longer be enrolled, an Active enrollment this campaign never emailed is
 * deleted, and an Active one it did email is marked Removed so its history
 * stays and the send engine (Active only) skips it. Every other enrollment
 * (Paused on a reply or unsubscribe, Bounced, Failed, Completed, Removed) is
 * left as it is and, since the lead is still enrolled, is never reactivated or
 * re-enrolled at step 1.
 *
 * It runs after the save commits, never inside its transaction: the lead and
 * enrollment ids are read first, the changes are written COHORT_SYNC_BATCH at
 * a time (writeSyncBatch), and cohortSyncRequestedAt is cleared last. Every
 * write touches only Active enrollments or skips duplicates, so a sync that
 * stopped part way (an error, a restart) is run again by the next save and
 * ends with the same enrollments. Returns false, having written no more, when
 * a later save took the sync over.
 */
export async function syncCohortEnrollments(
  campaignId: string,
  cohort: string,
  request: Date,
): Promise<boolean> {
  const enrollableLeadIds = await findEnrollableLeadIds(prisma, cohortLeadWhere(cohort));
  const eligibleLeadIds = new Set(enrollableLeadIds);

  const existingEnrollments = await prisma.campaignEnrollment.findMany({
    where: { campaignId },
    select: { id: true, leadId: true, status: true },
  });

  const leaving = existingEnrollments.filter((env) => env.status === 'Active' && !eligibleLeadIds.has(env.leadId));
  for (let i = 0; i < leaving.length; i += COHORT_SYNC_BATCH) {
    const batch = leaving.slice(i, i + COHORT_SYNC_BATCH);
    const written = await writeSyncBatch(campaignId, request, async (tx) => {
      const emailed = await tx.emailDispatch.findMany({
        where: { campaignId, leadId: { in: batch.map((env) => env.leadId) } },
        select: { leadId: true },
        distinct: ['leadId'],
      });
      const emailedLeadIds = new Set(emailed.map((d) => d.leadId));

      const toDelete = batch.filter((env) => !emailedLeadIds.has(env.leadId)).map((env) => env.id);
      if (toDelete.length > 0) {
        await tx.campaignEnrollment.deleteMany({
          where: { id: { in: toDelete }, status: 'Active' },
        });
      }

      const toRemove = batch.filter((env) => emailedLeadIds.has(env.leadId)).map((env) => env.id);
      if (toRemove.length > 0) {
        await tx.campaignEnrollment.updateMany({
          where: { id: { in: toRemove }, status: 'Active' },
          data: { status: REMOVED_ENROLLMENT_STATUS, nextActionDate: null },
        });
      }
    });
    if (!written) return false;
  }

  const enrolledLeadIds = new Set(existingEnrollments.map((env) => env.leadId));
  const newLeadsToEnroll = enrollableLeadIds.filter((leadId) => !enrolledLeadIds.has(leadId));
  for (let i = 0; i < newLeadsToEnroll.length; i += COHORT_SYNC_BATCH) {
    const batch = newLeadsToEnroll.slice(i, i + COHORT_SYNC_BATCH);
    const written = await writeSyncBatch(campaignId, request, (tx) =>
      tx.campaignEnrollment.createMany({
        data: batch.map((leadId) => ({
          leadId,
          campaignId,
          status: 'Active',
          currentSequenceStep: 1,
          nextActionDate: new Date(),
        })),
        skipDuplicates: true,
      }),
    );
    if (!written) return false;
  }

  // updatedAt is kept, so finishing the sync never makes an open editor's save look stale.
  return writeSyncBatch(campaignId, request, (tx, campaign) =>
    tx.campaign.updateMany({
      where: { id: campaignId },
      data: { cohortSyncRequestedAt: null, updatedAt: campaign.updatedAt },
    }),
  );
}

/**
 * Enroll `leadIds`, which just joined `groupIds`, in every campaign whose
 * audience is one of those groups, whatever its status, as pauseGroupLeavers
 * follows the leads that leave. Resuming a campaign, by hand or by the send
 * engine's auto-resume, never syncs its audience, so a Paused campaign skipped
 * here would never enroll them; like a Draft's, its new enrollments wait until
 * it is Active, the only status the send engine sends. Those of them in the
 * campaign's group that may be enrolled (findEnrollableLeadIds) start Active
 * at step 1, as syncCohortEnrollments enrolls a new member. A lead already
 * enrolled keeps its enrollment as it is, so one paused when it left the group,
 * or on a reply, is never restarted at step 1 or resumed.
 */
export async function enrollGroupJoiners(
  tx: Prisma.TransactionClient,
  leadIds: string[],
  groupIds: string[],
): Promise<void> {
  if (leadIds.length === 0 || groupIds.length === 0) return;
  const campaigns = await tx.campaign.findMany({
    where: { audienceCohort: { in: groupCohorts(groupIds) } },
    select: { id: true, audienceCohort: true },
  });
  for (const campaign of campaigns) {
    const enrollableLeadIds = await findEnrollableLeadIds(tx, {
      AND: [cohortLeadWhere(campaign.audienceCohort), { id: { in: leadIds } }],
    });
    if (enrollableLeadIds.length === 0) continue;
    await tx.campaignEnrollment.createMany({
      data: enrollableLeadIds.map((leadId) => ({
        leadId,
        campaignId: campaign.id,
        status: 'Active',
        currentSequenceStep: 1,
        nextActionDate: new Date(),
      })),
      skipDuplicates: true,
    });
  }
}

/**
 * Pause the Active enrollments of `leadIds`, which just left `groupIds`, in
 * every campaign whose audience is one of those groups, whatever the
 * campaign's status, so a lead taken out of a group is sent no further steps.
 * The enrollment is kept at its step with its history, never deleted, and one
 * that is already Paused or has ended (Completed, Bounced, Failed, Removed)
 * keeps its status.
 */
export async function pauseGroupLeavers(
  tx: Prisma.TransactionClient,
  leadIds: string[],
  groupIds: string[],
): Promise<void> {
  if (leadIds.length === 0 || groupIds.length === 0) return;
  await tx.campaignEnrollment.updateMany({
    where: {
      leadId: { in: leadIds },
      status: 'Active',
      campaign: { audienceCohort: { in: groupCohorts(groupIds) } },
    },
    data: { status: 'Paused' },
  });
}
