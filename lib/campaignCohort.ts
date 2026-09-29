import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
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
 * Bring a campaign's enrollments in line with `cohort`. The cohort's leads that
 * may be enrolled (findEnrollableLeadIds: not archived, unsubscribed, bounced,
 * invalid or on the suppression list) and are new to it are enrolled Active at
 * step 1. For a lead that left the cohort or may no longer be enrolled, an
 * Active enrollment this campaign never emailed is deleted, and an Active one
 * it did email is marked Removed so its history stays and the send engine
 * (Active only) skips it. Every other enrollment (Paused on a reply or
 * unsubscribe, Bounced, Failed, Completed, Removed) is left as it is and, since
 * the lead is still enrolled, is never reactivated or re-enrolled at step 1.
 */
export async function syncCohortEnrollments(
  tx: Prisma.TransactionClient,
  campaignId: string,
  cohort: string,
): Promise<void> {
  const enrollableLeadIds = await findEnrollableLeadIds(tx, cohortLeadWhere(cohort));
  const eligibleLeadIds = new Set(enrollableLeadIds);

  const existingEnrollments = await tx.campaignEnrollment.findMany({
    where: { campaignId },
    select: { id: true, leadId: true, status: true },
  });

  const leaving = existingEnrollments.filter((env) => env.status === 'Active' && !eligibleLeadIds.has(env.leadId));
  if (leaving.length > 0) {
    const emailed = await tx.emailDispatch.findMany({
      where: { campaignId, leadId: { in: leaving.map((env) => env.leadId) } },
      select: { leadId: true },
      distinct: ['leadId'],
    });
    const emailedLeadIds = new Set(emailed.map((d) => d.leadId));

    const toDelete = leaving.filter((env) => !emailedLeadIds.has(env.leadId)).map((env) => env.id);
    if (toDelete.length > 0) {
      await tx.campaignEnrollment.deleteMany({
        where: { id: { in: toDelete }, status: 'Active' },
      });
    }

    const toRemove = leaving.filter((env) => emailedLeadIds.has(env.leadId)).map((env) => env.id);
    if (toRemove.length > 0) {
      await tx.campaignEnrollment.updateMany({
        where: { id: { in: toRemove }, status: 'Active' },
        data: { status: REMOVED_ENROLLMENT_STATUS, nextActionDate: null },
      });
    }
  }

  const enrolledLeadIds = new Set(existingEnrollments.map((env) => env.leadId));
  const newLeadsToEnroll = enrollableLeadIds.filter((leadId) => !enrolledLeadIds.has(leadId));
  if (newLeadsToEnroll.length > 0) {
    await tx.campaignEnrollment.createMany({
      data: newLeadsToEnroll.map((leadId) => ({
        leadId,
        campaignId,
        status: 'Active',
        currentSequenceStep: 1,
        nextActionDate: new Date(),
      })),
      skipDuplicates: true,
    });
  }
}
