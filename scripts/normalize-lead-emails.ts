/**
 * Normalise stored lead emails (trimmed, lowercased) and merge case variants.
 *
 * Background: lead emails used to be stored exactly as typed or imported, so
 * 'Jane@Acme.com' and 'jane@acme.com' could be two leads that each got every
 * step, and replies from a mixed-case address were never matched. The app now
 * writes and matches emails through lib/leadEmail; this script brings the rows
 * stored before that in line, using the rules in lib/leadEmailMerge:
 *   - a lone lead stored with capitals or spaces gets its normalised email;
 *   - leads whose emails differ only in case or spaces are merged into one kept
 *     lead (the row already stored normalised, else the one with the most
 *     history), which takes the most restrictive status and validation of the
 *     group and every enrollment (one per campaign: a stopped one wins, else the
 *     one further along), dispatch, reply and group membership. The others are
 *     deleted, and their ids kept as LeadAlias rows so unsubscribe links already
 *     sent to them still work.
 * Leads whose email is blank are reported and left alone. Each merge runs in
 * its own transaction and is skipped if its leads or enrollments changed since
 * they were read (an unsubscribe or bounce landing mid-run, say) or a send
 * holds a live claim on one of their enrollments, so running it again is safe
 * and picks up anything skipped. Re-run until it exits 0.
 *
 * Needs the LeadAlias table (prisma db push) before --apply. Run --apply with
 * the send worker stopped (SEND_WORKER_ENABLED=false also stops IMAP sync) and
 * no Unibox replies being sent, so no send is in flight for a lead being
 * merged. Run it again once the code that normalises emails is deployed, to
 * catch rows the old code wrote in between.
 *
 * Usage:
 *   npx tsx scripts/normalize-lead-emails.ts            # dry-run report only (default, no writes)
 *   npx tsx scripts/normalize-lead-emails.ts --apply    # normalise and merge (writes)
 */
import { PrismaClient } from '@prisma/client';
import { type LeadEmailRow, mergeLeadGroup, planLeadEmails, resolveEnrollments } from '../lib/leadEmailMerge';

const prisma = new PrismaClient();

const DO_APPLY = process.argv.slice(2).includes('--apply');
const LIST_LIMIT = 50;

function describeRow(row: LeadEmailRow): string {
  return `${row.id} "${row.email}" (${row.status}, ${row.validationStatus}${row.isArchived ? ', archived' : ''}, history ${row.history})`;
}

async function main() {
  console.log(`[Lead Emails] Mode: ${DO_APPLY ? 'APPLY' : 'DRY-RUN (no changes)'}`);

  const leads = await prisma.lead.findMany({
    select: {
      id: true,
      email: true,
      name: true,
      company: true,
      jobTitle: true,
      status: true,
      validationStatus: true,
      isArchived: true,
      customVariables: true,
      _count: { select: { enrollments: true, dispatches: true, replies: true } },
    },
  });
  const rows: LeadEmailRow[] = leads.map(({ _count, ...lead }) => ({
    ...lead,
    history: _count.enrollments + _count.dispatches + _count.replies,
  }));

  const { plans, blank } = planLeadEmails(rows);
  const merges = plans.filter((p) => p.duplicates.length > 0);
  const renames = plans.filter((p) => p.duplicates.length === 0);
  const duplicateCount = merges.reduce((n, p) => n + p.duplicates.length, 0);

  console.log(
    `[Lead Emails] Leads: ${rows.length}. Email to normalise only: ${renames.length}. ` +
    `Case-variant groups to merge: ${merges.length} (${duplicateCount} duplicate lead(s) to delete). ` +
    `Blank emails left alone: ${blank.length}.`
  );

  for (const plan of renames.slice(0, LIST_LIMIT)) console.log(`  "${plan.keep.email}" -> "${plan.email}"`);
  if (renames.length > LIST_LIMIT) console.log(`  ... and ${renames.length - LIST_LIMIT} more.`);
  for (const row of blank) console.log(`  Blank email, left alone: ${row.id}`);

  if (merges.length > 0) {
    const groupLeadIds = merges.flatMap((p) => [p.keep.id, ...p.duplicates.map((d) => d.id)]);
    const enrollments = await prisma.campaignEnrollment.findMany({
      where: { leadId: { in: groupLeadIds } },
      select: {
        id: true, leadId: true, campaignId: true, status: true, currentSequenceStep: true,
        campaign: { select: { name: true } },
      },
    });
    for (const plan of merges) {
      const ids = new Set([plan.keep.id, ...plan.duplicates.map((d) => d.id)]);
      const resolution = resolveEnrollments(plan.keep.id, enrollments.filter((e) => ids.has(e.leadId)));
      console.log(`  ${plan.email}:`);
      console.log(`    keep   ${describeRow(plan.keep)}`);
      for (const dup of plan.duplicates) console.log(`    merge  ${describeRow(dup)}`);
      console.log(
        `    result ${plan.data.status}, ${plan.data.validationStatus}${plan.data.isArchived ? ', archived' : ''}; ` +
        `enrollments moved ${resolution.moveIds.length}, dropped as same-campaign duplicates ${resolution.deleteIds.length}, ` +
        `step raised ${resolution.stepUpdates.length}`
      );
      // An archived duplicate's Active enrollments stop being skipped once they move to a lead that is not archived.
      if (!plan.data.isArchived) {
        const archivedIds = new Set(plan.duplicates.filter((d) => d.isArchived).map((d) => d.id));
        const revived = enrollments.filter(
          (e) => resolution.moveIds.includes(e.id) && e.status === 'Active' && archivedIds.has(e.leadId),
        );
        if (revived.length > 0) {
          console.log(
            `    review ${revived.length} Active enrollment(s) move from an archived duplicate to a lead that is not archived: ` +
            revived.map((e) => `"${e.campaign.name}"`).join(', ')
          );
        }
      }
    }
  }

  if (!DO_APPLY) {
    if (plans.length > 0) console.log('[Lead Emails] Dry run. Re-run with --apply to write these changes.');
    return;
  }

  const failed: string[] = [];
  let merged = 0;
  for (const plan of merges) {
    try {
      await prisma.$transaction((tx) => mergeLeadGroup(tx, plan), { timeout: 30_000 });
      merged++;
    } catch (e) {
      failed.push(`${plan.email}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  let renamed = 0;
  for (const plan of renames) {
    try {
      // Match the email read above so a lead changed in the meantime is not overwritten.
      const res = await prisma.lead.updateMany({
        where: { id: plan.keep.id, email: plan.keep.email },
        data: { email: plan.email },
      });
      if (res.count === 1) renamed++;
      else failed.push(`${plan.email}: its lead changed since it was read; re-run to plan it again`);
    } catch (e) {
      failed.push(`${plan.email}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  console.log(`[Lead Emails] Merged ${merged} group(s), normalised ${renamed} email(s).`);
  if (failed.length > 0) {
    console.log(`[Lead Emails] Skipped ${failed.length}:`);
    for (const line of failed) console.log(`  ${line}`);
    process.exitCode = 1;
  }
}

main()
  .catch((e) => {
    console.error('[Lead Emails] Error:', e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
