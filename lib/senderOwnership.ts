import type { SenderAccount } from '@prisma/client';
import { prisma } from '@/lib/db';
import type { UserSession } from '@/lib/session';

/**
 * Sender mailboxes a campaign writes must belong to the campaign's owner.
 * Without this, a user can point their campaign at another user's mailbox,
 * send from that address, spend its caps and have replies land in its inbox.
 */

export interface SenderCheckError {
  status: 400 | 403 | 404;
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
