import type { Prisma } from '@prisma/client';
import type { UserSession } from '@/lib/session';

/**
 * Leads are shared across the CRM, but the mail exchanged with a lead belongs
 * to the user who sent or received it. The lead timeline and Unibox load a
 * lead's history through these filters: non-admins see replies that arrived in
 * their own mailboxes, enrollments in their own campaigns, and dispatches as
 * described on dispatchScope. Admins see every user's history, so each filter
 * is undefined for them.
 */

type Caller = Pick<UserSession, 'id' | 'role'>;

/**
 * A dispatch that records a mailbox belongs to that mailbox's owner, whatever
 * campaign it was stamped with: a Unibox reply inherits the campaign of the
 * inbound it answers, which can be another user's. Campaign ownership only
 * decides for sequence sends (stepOrder set by the send engine and campaign
 * run) and for dispatches with no mailbox, such as sends made before mailboxes
 * were recorded.
 */
export function dispatchScope(session: Caller): Prisma.EmailDispatchWhereInput | undefined {
  if (session.role === 'ADMIN') return undefined;
  return {
    OR: [
      { senderAccount: { userId: session.id } },
      { senderAccountId: null, campaign: { userId: session.id } },
      { stepOrder: { not: null }, campaign: { userId: session.id } },
    ],
  };
}

export function replyScope(session: Caller): Prisma.InboundResponseWhereInput | undefined {
  if (session.role === 'ADMIN') return undefined;
  return { senderAccount: { userId: session.id } };
}

export function enrollmentScope(session: Caller): Prisma.CampaignEnrollmentWhereInput | undefined {
  if (session.role === 'ADMIN') return undefined;
  return { campaign: { userId: session.id } };
}

/** The campaign columns the lead timeline and Unibox show next to a message. */
export const CAMPAIGN_LABEL_SELECT = {
  id: true,
  name: true,
} as const satisfies Prisma.CampaignSelect;
