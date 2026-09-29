import { randomUUID } from 'crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from './db';

/** How long a send claim holds an enrollment; a claim older than this was abandoned by a crashed or hung send. */
export const SEND_CLAIM_TTL_MS = 10 * 60 * 1000;

/** Enrollment update fields that release a send claim. */
export const RELEASED_CLAIM = { claimToken: null, claimedAt: null };

/**
 * The one definition of "this enrollment may be sent now": the enrollment and
 * its campaign are Active, and the lead is not archived, unsubscribed, bounced
 * or invalid. Every query that picks enrollments to send and every per-send
 * claim uses it, so suppression added here applies to all of them.
 */
export function sendableEnrollmentWhere(): Prisma.CampaignEnrollmentWhereInput {
  return {
    status: 'Active',
    campaign: { status: 'Active' },
    lead: {
      isArchived: false,
      status: { notIn: ['Bounced', 'Unsubscribed'] },
      validationStatus: { notIn: ['Invalid'] },
    },
  };
}

/**
 * Claims an enrollment for sending step `stepOrder`, right before the send,
 * with a conditional write that only succeeds while the enrollment is still
 * sendable, still on that step, and not claimed by another send (or its claim
 * has expired). This re-checks pause, unsubscribe and reply at send time.
 * Returns the claim token, or null when the enrollment must not be sent.
 */
export async function claimEnrollmentForSend(
  enrollmentId: string,
  stepOrder: number,
  now: Date = new Date(),
): Promise<string | null> {
  const claimToken = randomUUID();
  const staleBefore = new Date(now.getTime() - SEND_CLAIM_TTL_MS);
  const { count } = await prisma.campaignEnrollment.updateMany({
    where: {
      id: enrollmentId,
      currentSequenceStep: stepOrder,
      AND: [
        sendableEnrollmentWhere(),
        { OR: [{ claimedAt: null }, { claimedAt: { lt: staleBefore } }] },
      ],
    },
    data: { claimToken, claimedAt: now },
  });
  return count === 1 ? claimToken : null;
}

/** Releases a claim taken by claimEnrollmentForSend, if it is still that claim. */
export async function releaseEnrollmentClaim(enrollmentId: string, claimToken: string): Promise<void> {
  await prisma.campaignEnrollment.updateMany({
    where: { id: enrollmentId, claimToken },
    data: RELEASED_CLAIM,
  });
}
