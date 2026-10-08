/**
 * The checks a save makes so that a campaign's sender pool always has a
 * mailbox for every lead (lib/senderRouting): a mailbox limited to Recipient
 * Domains sends to those only, so a pool needs at least one mailbox with no
 * list, and a save that would leave none is refused.
 */

import { prisma } from '@/lib/db';
import { STOPPED_STATUS } from '@/lib/campaignStop';
import { resolveCampaignSenders, resolveSenderRoutes } from '@/lib/sendEngine';
import { parseRecipientDomains, storedRecipientDomains, unroutedPoolError } from '@/lib/senderRouting';
import { isPlainObject } from '@/lib/updateAllowList';

/** A campaign's sender pool entry (CampaignSenderAccount) as a save stores it. */
export type PoolRow = { senderAccountId: string; recipientDomains: string[] };

/**
 * The pool rows a campaign save stores, from its body and the stored rows.
 * `senderAccountIds`, when a list, names the pool; otherwise it stays as
 * stored. `senderRecipientDomains` maps a pool mailbox's ID to the campaign's
 * Recipient Domains for it; a mailbox it leaves out keeps the list it has
 * stored. A list for a mailbox outside the pool, or one that is no list of
 * domain names, is an error.
 */
export function planPoolRows(
  body: { senderAccountIds?: unknown; senderRecipientDomains?: unknown },
  stored: Array<{ senderAccountId: string; recipientDomains?: unknown }>,
): { rows: PoolRow[]; error: null } | { rows: null; error: string } {
  const ids: string[] = Array.isArray(body.senderAccountIds)
    ? [...new Set(body.senderAccountIds as string[])]
    : stored.map((row) => row.senderAccountId);

  const sent = new Map<string, string[]>();
  if (body.senderRecipientDomains !== undefined) {
    if (!isPlainObject(body.senderRecipientDomains)) {
      return { rows: null, error: 'senderRecipientDomains must map mailbox IDs to lists of domain names.' };
    }
    for (const [senderAccountId, value] of Object.entries(body.senderRecipientDomains)) {
      if (!ids.includes(senderAccountId)) {
        return { rows: null, error: 'Recipient Domains were sent for a mailbox that is not in the campaign\'s sender pool.' };
      }
      const parsed = parseRecipientDomains(value);
      if (parsed.error !== null) return { rows: null, error: parsed.error };
      sent.set(senderAccountId, parsed.domains);
    }
  }

  const kept = new Map(stored.map((row) => [row.senderAccountId, storedRecipientDomains(row.recipientDomains)]));
  return {
    rows: ids.map((senderAccountId) => ({
      senderAccountId,
      recipientDomains: sent.get(senderAccountId) ?? kept.get(senderAccountId) ?? [],
    })),
    error: null,
  };
}

/**
 * Why the pool a campaign save would store leaves leads with no mailbox to
 * send from (NO_OPEN_SENDER_ERROR), or null. The pool is resolved as the send
 * engine resolves it, from the owner's mailboxes among `rows` or else the
 * primary sender, and each mailbox's own list goes before the campaign's.
 */
export async function poolRoutingError(ownerId: string, primaryId: string, rows: PoolRow[]): Promise<string | null> {
  const accounts = await prisma.senderAccount.findMany({
    where: { id: { in: [...new Set([primaryId, ...rows.map((row) => row.senderAccountId)])] } },
    select: { id: true, userId: true, recipientDomains: true },
  });
  const byId = new Map(accounts.map((account) => [account.id, account]));
  const campaign = {
    userId: ownerId,
    senderAccount: byId.get(primaryId),
    senders: rows
      .filter((row) => byId.has(row.senderAccountId))
      .map((row) => ({ senderAccount: byId.get(row.senderAccountId), recipientDomains: row.recipientDomains })),
  };
  const { pool } = resolveCampaignSenders(campaign);
  return unroutedPoolError(pool, resolveSenderRoutes(campaign, pool));
}

/**
 * The campaigns that giving mailbox `mailboxId` the Recipient Domains
 * `domains` would leave with no mailbox for leads at other domains, by name.
 * A Stopped campaign is left out: it sends nothing and can't be edited until
 * it is restarted, and once it is, the send engine holds back the leads no
 * mailbox sends to.
 */
export async function campaignsLeftUnrouted(mailboxId: string, domains: string[]): Promise<Array<{ name: string; userId: string }>> {
  if (domains.length === 0) return [];
  const account = { select: { id: true, userId: true, recipientDomains: true } } as const;
  const campaigns = await prisma.campaign.findMany({
    where: {
      status: { not: STOPPED_STATUS },
      OR: [{ senderAccountId: mailboxId }, { senders: { some: { senderAccountId: mailboxId } } }],
    },
    select: {
      name: true,
      userId: true,
      senderAccount: account,
      senders: { select: { recipientDomains: true, senderAccount: account } },
    },
    orderBy: { name: 'asc' },
  });
  const withList = <T extends { id: string }>(mailbox: T): T => (mailbox.id === mailboxId ? { ...mailbox, recipientDomains: domains } : mailbox);
  return campaigns
    .filter((campaign) => {
      const changed = {
        userId: campaign.userId,
        senderAccount: withList(campaign.senderAccount),
        senders: campaign.senders.map((row) => ({ ...row, senderAccount: withList(row.senderAccount) })),
      };
      const { pool } = resolveCampaignSenders(changed);
      return unroutedPoolError(pool, resolveSenderRoutes(changed, pool)) !== null;
    })
    .map(({ name, userId }) => ({ name, userId }));
}
