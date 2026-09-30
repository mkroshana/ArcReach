import type { Prisma } from '@prisma/client';
import { normalizeEmail } from './leadEmail';

/**
 * Every lead delete in the app goes through deleteLeads (a merge of case-variant
 * leads keeps the removed ids as LeadAlias rows instead). A delete cascades the lead's
 * enrollments, dispatches, replies and LeadAlias rows, but unsubscribe links in
 * mail already sent carry the lead's id (or the id of a lead merged into it).
 * So before a lead that was emailed is deleted, its id and its aliases' ids are
 * recorded in DeletedLead with its address. DeletedLead has no relation to
 * Lead, so the delete leaves it in place, and /api/unsubscribe finds the
 * address there and puts it on the suppression list. A lead never emailed has
 * no link in anyone's inbox, so its address is not kept.
 */

type LeadDeleteClient = Pick<Prisma.TransactionClient, 'lead' | 'deletedLead'>;

/**
 * Most leads read and deleted per round, and most DeletedLead rows per write:
 * the delete's id list and the write (2 values a row) stay under Postgres's
 * 32767 bind parameters.
 */
const LEAD_DELETE_CHUNK = 5000;

/**
 * Deletes the leads matching `where` in rounds, recording the ids of those
 * that were emailed in DeletedLead first. Returns how many leads were deleted.
 */
export async function deleteLeads(client: LeadDeleteClient, where: Prisma.LeadWhereInput): Promise<number> {
  let deleted = 0;
  for (;;) {
    // Each round reads the first leads still matching, so Delete All also takes leads added meanwhile
    const leads = await client.lead.findMany({
      where,
      select: { id: true, email: true, aliases: { select: { id: true } }, _count: { select: { dispatches: true } } },
      take: LEAD_DELETE_CHUNK,
    });
    if (leads.length === 0) return deleted;

    const ids: { id: string; email: string }[] = [];
    for (const lead of leads) {
      const email = normalizeEmail(lead.email);
      if (!email || lead._count.dispatches === 0) continue;
      ids.push({ id: lead.id, email }, ...lead.aliases.map((alias) => ({ id: alias.id, email })));
    }
    for (let i = 0; i < ids.length; i += LEAD_DELETE_CHUNK) {
      await client.deletedLead.createMany({ data: ids.slice(i, i + LEAD_DELETE_CHUNK), skipDuplicates: true });
    }

    const { count } = await client.lead.deleteMany({ where: { id: { in: leads.map((lead) => lead.id) } } });
    deleted += count;
    if (leads.length < LEAD_DELETE_CHUNK) return deleted;
  }
}
