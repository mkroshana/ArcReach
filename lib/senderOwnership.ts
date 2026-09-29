import type { SenderAccount } from '@prisma/client';
import { prisma } from '@/lib/db';
import type { UserSession } from '@/lib/session';

/**
 * Sender mailboxes a campaign writes must belong to the campaign's owner.
 * Without this, a user can point their campaign at another user's mailbox,
 * send from that address, spend its caps and have replies land in its inbox.
 */

export interface SenderCheckError {
  status: 400 | 403 | 404 | 409;
  error: string;
}

/** The IDs among `ids` that are not mailboxes of `ownerId`, unknown IDs included. */
async function findForeignSenderIds(ownerId: string, ids: string[]): Promise<string[]> {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) return [];

  const owned = await prisma.senderAccount.findMany({
    where: { id: { in: uniqueIds }, userId: ownerId },
    select: { id: true },
  });
  const ownedIds = new Set(owned.map((a) => a.id));
  return uniqueIds.filter((id) => !ownedIds.has(id));
}

/**
 * Check the senderAccountId / senderAccountIds values of a campaign body
 * against `ownerId`. Only values the route writes are checked: senderAccountId
 * when present, senderAccountIds when it is an array. Unknown IDs fail the same
 * way as other users' IDs so mailbox IDs cannot be probed.
 */
export async function checkCampaignSenders(
  ownerId: string,
  senderAccountId: unknown,
  senderAccountIds: unknown,
): Promise<SenderCheckError | null> {
  const ids: string[] = [];
  if (senderAccountId !== undefined) {
    if (typeof senderAccountId !== 'string' || senderAccountId === '') {
      return { status: 400, error: 'senderAccountId must be a mailbox ID.' };
    }
    ids.push(senderAccountId);
  }
  if (Array.isArray(senderAccountIds)) {
    if (!senderAccountIds.every((id) => typeof id === 'string' && id !== '')) {
      return { status: 400, error: 'senderAccountIds must be a list of mailbox IDs.' };
    }
    ids.push(...senderAccountIds);
  }

  const foreign = await findForeignSenderIds(ownerId, ids);
  if (foreign.length > 0) {
    return { status: 403, error: `Sender mailbox does not belong to the campaign owner: ${foreign.join(', ')}.` };
  }
  return null;
}

/**
 * Check a stored campaign's sender mailboxes (its primary sender and its pool)
 * against `newOwnerId` before the campaign is assigned to that user. The send
 * engine never sends from a mailbox the campaign's owner does not own, so a
 * reassignment that would leave any is refused with a 409 naming them.
 */
export async function checkReassignedCampaignSenders(
  newOwnerId: string,
  campaign: {
    senderAccountId: string;
    senderAccount?: { emailAddress: string } | null;
    senders: Array<{ senderAccountId: string; senderAccount?: { emailAddress: string } | null }>;
  },
): Promise<SenderCheckError | null> {
  const addresses = new Map<string, string | undefined>([
    [campaign.senderAccountId, campaign.senderAccount?.emailAddress],
    ...campaign.senders.map((s) => [s.senderAccountId, s.senderAccount?.emailAddress] as [string, string | undefined]),
  ]);
  const foreign = await findForeignSenderIds(newOwnerId, [...addresses.keys()]);
  if (foreign.length === 0) return null;
  const names = foreign.map((id) => addresses.get(id) ?? id).join(', ');
  const them = foreign.length === 1 ? 'that mailbox' : 'those mailboxes';
  return {
    status: 409,
    error: `Cannot assign this campaign to that user: it sends from ${names}, which the new owner does not own. A campaign only sends from its owner's mailboxes, so assign ${them} to the new owner first.`,
  };
}

/**
 * Load the mailbox a direct send (Unibox reply, manual send, mailbox test)
 * names. Non-admins may only send from their own mailboxes, and unknown IDs
 * fail the same way as other users' IDs; admins may use any mailbox.
 */
export async function findDirectSender(
  session: Pick<UserSession, 'id' | 'role'>,
  senderAccountId: unknown,
): Promise<{ account: SenderAccount } | SenderCheckError> {
  if (typeof senderAccountId !== 'string' || senderAccountId === '') {
    return { status: 400, error: 'senderAccountId must be a mailbox ID.' };
  }
  const account = await prisma.senderAccount.findUnique({ where: { id: senderAccountId } });
  if (session.role === 'ADMIN') {
    if (!account) return { status: 404, error: 'Sender mailbox not found.' };
  } else if (!account || account.userId !== session.id) {
    return { status: 403, error: 'Sender mailbox does not belong to you.' };
  }
  return { account };
}
