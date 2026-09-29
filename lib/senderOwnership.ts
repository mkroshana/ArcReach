import { prisma } from '@/lib/db';

/**
 * Sender mailboxes a campaign writes must belong to the campaign's owner.
 * Without this, a user can point their campaign at another user's mailbox,
 * send from that address, spend its caps and have replies land in its inbox.
 */

export interface SenderCheckError {
  status: 400 | 403;
  error: string;
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

  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) return null;

  const owned = await prisma.senderAccount.findMany({
    where: { id: { in: uniqueIds }, userId: ownerId },
    select: { id: true },
  });
  const ownedIds = new Set(owned.map((a) => a.id));
  const foreign = uniqueIds.filter((id) => !ownedIds.has(id));
  if (foreign.length > 0) {
    return { status: 403, error: `Sender mailbox does not belong to the campaign owner: ${foreign.join(', ')}.` };
  }
  return null;
}
