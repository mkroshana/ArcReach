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
 * claim uses it, so suppression added here applies to all of them. It has
 * relation filters, so conditional writes read with it and then re-check only
 * the enrollment's own columns (see claimEnrollmentForSend).
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
 * Claims an enrollment for sending step `stepOrder`, right before the send.
 * The claim is one conditional UPDATE of the enrollment row on its own
 * columns only: still Active, still on that step, and not claimed by another
 * send (or its claim has expired). Postgres checks those conditions on the row
 * it locks and re-checks them once a concurrent claim commits, so of two
 * racing claims exactly one wins. Campaign and lead filters are left out of
 * that write: Prisma evaluates relation filters in an updateMany by a separate
 * read or a subquery on the statement's snapshot, which two claims can both
 * pass. The claimed enrollment is then checked against sendableEnrollmentWhere(),
 * which re-checks pause, unsubscribe and reply at send time, and the claim is
 * released if it no longer qualifies. Returns the claim token, or null when
 * the enrollment must not be sent.
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
      status: 'Active',
      OR: [{ claimedAt: null }, { claimedAt: { lt: staleBefore } }],
    },
    data: { claimToken, claimedAt: now },
  });
  if (count !== 1) return null;

  const sendable = await prisma.campaignEnrollment.findFirst({
    where: { ...sendableEnrollmentWhere(), id: enrollmentId, claimToken },
    select: { id: true },
  });
  if (!sendable) {
    await releaseEnrollmentClaim(enrollmentId, claimToken);
    return null;
  }
  return claimToken;
}

/** Releases a claim taken by claimEnrollmentForSend, if it is still that claim. */
export async function releaseEnrollmentClaim(enrollmentId: string, claimToken: string): Promise<void> {
  await prisma.campaignEnrollment.updateMany({
    where: { id: enrollmentId, claimToken },
    data: RELEASED_CLAIM,
  });
}
