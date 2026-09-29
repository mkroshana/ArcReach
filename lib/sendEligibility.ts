import { randomUUID } from 'crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from './db';
import { normalizeEmail } from './leadEmail';
import { suppressionReasons } from './suppression';

/** How long a send claim holds an enrollment; a claim older than this was abandoned by a crashed or hung send. */
export const SEND_CLAIM_TTL_MS = 10 * 60 * 1000;

/** Enrollment update fields that release a send claim. */
export const RELEASED_CLAIM = { claimToken: null, claimedAt: null };

/** Lead filter for leads that may be emailed: not archived, unsubscribed, bounced or invalid. */
export function sendableLeadWhere(): Prisma.LeadWhereInput {
  return {
    isArchived: false,
    status: { notIn: ['Bounced', 'Unsubscribed'] },
    validationStatus: { notIn: ['Invalid'] },
  };
}

/**
 * The one definition of "this enrollment may be sent now": the enrollment and
 * its campaign are Active, and the lead is not archived, unsubscribed, bounced
 * or invalid. Every query that picks enrollments to send and every per-send
 * claim uses it, so suppression added here applies to all of them. It has
 * relation filters, so conditional writes read with it and then re-check only
 * the enrollment's own columns (see claimEnrollmentForSend). The suppression
 * list has no relation to Lead that a filter could follow, so it is checked on
 * the rows read with it: by the claim right before every send, and through
 * withoutSuppressedLeads where enrollments are queued.
 */
export function sendableEnrollmentWhere(): Prisma.CampaignEnrollmentWhereInput {
  return {
    status: 'Active',
    campaign: { status: 'Active' },
    lead: sendableLeadWhere(),
  };
}

/** `rows` less those whose lead's address is on the suppression list. */
export async function withoutSuppressedLeads<T extends { lead: { email: string } }>(rows: T[]): Promise<T[]> {
  const suppressed = await suppressionReasons(prisma, rows.map((row) => row.lead.email));
  return suppressed.size === 0 ? rows : rows.filter((row) => !suppressed.has(normalizeEmail(row.lead.email)));
}

/**
 * Ids of the leads matching `where` that may be enrolled: sendable
 * (sendableLeadWhere) and not on the suppression list. Every path that enrolls
 * leads or re-activates their enrollments goes through it, so none leaves an
 * Active enrollment the send engine would never send.
 */
export async function findEnrollableLeadIds(
  client: Pick<Prisma.TransactionClient, 'lead' | 'suppressedEmail'>,
  where: Prisma.LeadWhereInput,
): Promise<string[]> {
  const leads = await client.lead.findMany({
    where: { AND: [where, sendableLeadWhere()] },
    select: { id: true, email: true },
  });
  const suppressed = await suppressionReasons(client, leads.map((lead) => lead.email));
  return leads.filter((lead) => !suppressed.has(normalizeEmail(lead.email))).map((lead) => lead.id);
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
 * released if it no longer qualifies. An enrollment whose lead's address is on
 * the suppression list is paused as well, whatever the lead's status says, so
 * the due query stops picking it up. Returns the claim token, or null when the
 * enrollment must not be sent.
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
    select: { id: true, lead: { select: { email: true } } },
  });
  if (!sendable) {
    await releaseEnrollmentClaim(enrollmentId, claimToken);
    return null;
  }
  if ((await withoutSuppressedLeads([sendable])).length === 0) {
    await prisma.campaignEnrollment.updateMany({
      where: { id: enrollmentId, claimToken },
      data: { status: 'Paused', nextActionDate: null, ...RELEASED_CLAIM },
    });
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
