/**
 * Fill the suppression list (SuppressedEmail) from the leads suppressed before it existed.
 *
 * Background: suppression used to live only on the Lead row (status
 * Unsubscribed or Bounced, validation Invalid), so deleting a lead and
 * importing it again mailed an opted-out or bounced address again. The app now
 * keeps a suppression list apart from Lead (lib/suppression.ts), written on
 * every unsubscribe, hard bounce and failed verification and checked on every
 * lead create, import, enrollment and send. This script adds the addresses of
 * existing leads that are:
 *   - status Unsubscribed  -> reason Unsubscribed;
 *   - status Bounced       -> reason HardBounce;
 *   - validation Invalid   -> reason Invalid;
 * taking the first that applies. An address already on the list keeps its
 * reason. It also pauses the Active enrollments of every lead whose address is
 * on the list, as an unsubscribe pauses them: the send engine never sends
 * them, and left Active they show on the campaign pages as queued forever.
 * Leads whose email is blank are reported and left alone. Running it again is
 * safe; a second run finds nothing to do.
 *
 * Needs the SuppressedEmail table (prisma db push) before --apply.
 *
 * Usage:
 *   npx tsx scripts/backfill-suppression.ts            # dry-run report only (default, no writes)
 *   npx tsx scripts/backfill-suppression.ts --apply    # add the addresses and pause the enrollments (writes)
 */
import { PrismaClient, type SuppressionReason } from '@prisma/client';
import { normalizeEmail } from '../lib/leadEmail';
import { suppressEmails } from '../lib/suppression';

const prisma = new PrismaClient();

const DO_APPLY = process.argv.slice(2).includes('--apply');
const LIST_LIMIT = 50;
/** Most lead ids one enrollment query names, to stay under Postgres's bind-parameter limit. */
const LEAD_ID_CHUNK = 1000;

function reasonFor(lead: { status: string; validationStatus: string }): SuppressionReason | null {
  if (lead.status === 'Unsubscribed') return 'Unsubscribed';
  if (lead.status === 'Bounced') return 'HardBounce';
  if (lead.validationStatus === 'Invalid') return 'Invalid';
  return null;
}

function chunks<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += LEAD_ID_CHUNK) out.push(items.slice(i, i + LEAD_ID_CHUNK));
  return out;
}

async function main() {
  console.log(`[Suppression Backfill] Mode: ${DO_APPLY ? 'APPLY' : 'DRY-RUN (no changes)'}`);

  const leads = await prisma.lead.findMany({
    select: { id: true, email: true, status: true, validationStatus: true },
  });
  const listed = new Set((await prisma.suppressedEmail.findMany({ select: { email: true } })).map((row) => row.email));

  const toAdd = new Map<string, SuppressionReason>();
  const blank: string[] = [];
  for (const lead of leads) {
    const reason = reasonFor(lead);
    if (!reason) continue;
    const email = normalizeEmail(lead.email);
    if (!email) {
      blank.push(lead.id);
      continue;
    }
    if (!listed.has(email) && !toAdd.has(email)) toAdd.set(email, reason);
  }

  const byReason = new Map<SuppressionReason, number>();
  for (const reason of toAdd.values()) byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
  console.log(
    `[Suppression Backfill] Leads: ${leads.length}. Already on the list: ${listed.size}. ` +
    `Addresses to add: ${toAdd.size}` +
    (toAdd.size > 0 ? ` (${[...byReason].map(([reason, n]) => `${reason} ${n}`).join(', ')})` : '') +
    `. Blank emails left alone: ${blank.length}.`
  );
  for (const [email, reason] of [...toAdd].slice(0, LIST_LIMIT)) console.log(`  ${email} (${reason})`);
  if (toAdd.size > LIST_LIMIT) console.log(`  ... and ${toAdd.size - LIST_LIMIT} more.`);
  for (const id of blank) console.log(`  Blank email, left alone: ${id}`);

  // Leads whose address is on the list once the additions are written
  const suppressedLeadIds = leads
    .filter((lead) => {
      const email = normalizeEmail(lead.email);
      return email !== '' && (listed.has(email) || toAdd.has(email));
    })
    .map((lead) => lead.id);
  let activeEnrollments = 0;
  for (const ids of chunks(suppressedLeadIds)) {
    activeEnrollments += await prisma.campaignEnrollment.count({ where: { leadId: { in: ids }, status: 'Active' } });
  }
  console.log(`[Suppression Backfill] Active enrollments of suppressed leads to pause: ${activeEnrollments}.`);

  if (!DO_APPLY) {
    if (toAdd.size > 0 || activeEnrollments > 0) console.log('[Suppression Backfill] Dry run. Re-run with --apply to write these changes.');
    return;
  }

  const added = await suppressEmails(
    prisma,
    [...toAdd].map(([email, reason]) => ({ email, reason })),
    'backfill',
  );

  let paused = 0;
  for (const ids of chunks(suppressedLeadIds)) {
    const { count } = await prisma.campaignEnrollment.updateMany({
      where: { leadId: { in: ids }, status: 'Active' },
      data: { status: 'Paused', nextActionDate: null },
    });
    paused += count;
  }

  console.log(`[Suppression Backfill] Added ${added} address(es) to the suppression list. Paused ${paused} enrollment(s).`);
}

main()
  .catch((e) => {
    console.error('[Suppression Backfill] Error:', e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
