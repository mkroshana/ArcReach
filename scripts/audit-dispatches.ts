/**
 * Audit & clean up EmailDispatch rows.
 *
 * Background: historically a dispatch row was created for every send *attempt*
 * (before the send, and never removed on failure), and repeated manual campaign
 * runs could re-send the same step to the same lead. This inflated the
 * "Total Dispatched / Sent / Opens / Clicks" metrics. This script reports — and
 * optionally cleans up — the resulting duplicate/orphan rows.
 *
 * Usage:
 *   npx tsx scripts/audit-dispatches.ts                 # dry-run report only (default, no writes)
 *   npx tsx scripts/audit-dispatches.ts --backfill      # set stepOrder on legacy rows (writes)
 *   npx tsx scripts/audit-dispatches.ts --fix           # delete duplicate rows, keeping the earliest (writes)
 *   npx tsx scripts/audit-dispatches.ts --backfill --fix
 *
 * "Duplicate" = more than one dispatch for the same (campaign, lead, step). Step
 * is taken from the stored stepOrder when present, otherwise inferred from the
 * subject via the same heuristic the dashboard uses. The earliest send (by
 * sentAt) is kept; the rest are reported/deleted. Deleting a dispatch cascades
 * its EmailEvent rows.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const args = new Set(process.argv.slice(2));
const DO_FIX = args.has('--fix');
const DO_BACKFILL = args.has('--backfill');

// Mirror of the dashboard's subject->step matcher (app/campaigns/page.tsx).
function isDispatchForStep(dispatchSubject: string, stepSubject: string): boolean {
  if (!dispatchSubject || !stepSubject) return false;
  const cleanStep = stepSubject.trim().toLowerCase();
  const cleanDispatch = dispatchSubject.trim().toLowerCase();
  if (cleanDispatch === cleanStep) return true;
  let pattern = cleanStep.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
  pattern = pattern.replace(/\s+/g, '(?:\\s+|\\b)');
  pattern = pattern.replace(/\\\{\\\{[^}]+\\\}\\\}/g, '.*');
  pattern = pattern.replace(/\\\{([^{}]+)\\\}/g, (_m, optionsEscaped: string) => {
    const options = optionsEscaped.replace(/\\\|/g, '|');
    return `(${options})`;
  });
  try {
    const regex = new RegExp(`^${pattern}\\s*\\.*\\!*\\??$`);
    return regex.test(cleanDispatch);
  } catch {
    return cleanDispatch.includes(cleanStep.replace(/\{\{[^}]+\}\}/g, '').replace(/\{[^}]+\}/g, '').trim());
  }
}

async function main() {
  console.log(`\n=== EmailDispatch audit ===`);
  console.log(`Mode: ${DO_FIX || DO_BACKFILL ? 'WRITE' : 'DRY-RUN (no changes)'}` +
    `${DO_BACKFILL ? ' [+backfill stepOrder]' : ''}${DO_FIX ? ' [+delete duplicates]' : ''}\n`);

  const totalRows = await prisma.emailDispatch.count();
  const byStatus = await prisma.emailDispatch.groupBy({ by: ['status'], _count: { id: true } });
  console.log(`Total dispatch rows: ${totalRows}`);
  for (const s of byStatus) console.log(`  status="${s.status}": ${s._count.id}`);

  const campaigns = await prisma.campaign.findMany({
    include: { steps: { orderBy: { stepOrder: 'asc' } } },
  });

  let totalInferable = 0;
  let totalBackfilled = 0;
  let totalDuplicates = 0;
  const backfillUpdates: { id: string; stepOrder: number }[] = [];
  const duplicateIds: string[] = [];

  for (const campaign of campaigns) {
    const dispatches = await prisma.emailDispatch.findMany({
      where: { campaignId: campaign.id },
      orderBy: { sentAt: 'asc' },
      select: { id: true, leadId: true, subject: true, stepOrder: true, sentAt: true },
    });
    if (dispatches.length === 0) continue;

    // Resolve a step key for each dispatch: stored stepOrder, else inferred from subject.
    const groups = new Map<string, typeof dispatches>();
    for (const d of dispatches) {
      let step: number | null = d.stepOrder ?? null;
      if (step === null && d.subject) {
        const match = campaign.steps.find(s => isDispatchForStep(d.subject || '', s.subject || ''));
        if (match) {
          step = match.stepOrder;
          totalInferable++;
          if (DO_BACKFILL) backfillUpdates.push({ id: d.id, stepOrder: step });
        }
      }
      // Group key: fall back to a normalized subject when the step can't be resolved.
      const key = `${d.leadId}::${step !== null ? `step${step}` : `subj:${(d.subject || '').trim().toLowerCase()}`}`;
      const arr = groups.get(key) || [];
      arr.push(d);
      groups.set(key, arr);
    }

    let campaignDupes = 0;
    for (const [, arr] of groups) {
      if (arr.length > 1) {
        // Keep the earliest (arr is sorted by sentAt asc); the rest are duplicates.
        for (const dup of arr.slice(1)) {
          duplicateIds.push(dup.id);
          campaignDupes++;
        }
      }
    }
    if (campaignDupes > 0) {
      totalDuplicates += campaignDupes;
      console.log(`\nCampaign "${campaign.name}" (${campaign.id}): ${dispatches.length} rows, ${campaignDupes} duplicate(s)`);
    }
  }

  console.log(`\n--- Summary ---`);
  console.log(`Legacy rows whose step could be inferred from subject: ${totalInferable}`);
  console.log(`Duplicate rows (same campaign+lead+step, beyond the earliest): ${totalDuplicates}`);

  if (DO_BACKFILL) {
    console.log(`\nBackfilling stepOrder on ${backfillUpdates.length} row(s)...`);
    for (const u of backfillUpdates) {
      await prisma.emailDispatch.update({ where: { id: u.id }, data: { stepOrder: u.stepOrder } });
      totalBackfilled++;
    }
    console.log(`Backfilled ${totalBackfilled} row(s).`);
  } else if (totalInferable > 0) {
    console.log(`(Run with --backfill to write the inferred stepOrder values.)`);
  }

  if (DO_FIX) {
    console.log(`\nDeleting ${duplicateIds.length} duplicate row(s) (EmailEvents cascade)...`);
    let deleted = 0;
    const batchSize = 500;
    for (let i = 0; i < duplicateIds.length; i += batchSize) {
      const batch = duplicateIds.slice(i, i + batchSize);
      const res = await prisma.emailDispatch.deleteMany({ where: { id: { in: batch } } });
      deleted += res.count;
    }
    console.log(`Deleted ${deleted} duplicate row(s).`);
  } else if (totalDuplicates > 0) {
    console.log(`(Run with --fix to delete these duplicate rows, keeping the earliest send per step.)`);
  }

  console.log(`\nDone.\n`);
}

main()
  .catch((e) => {
    console.error('[Audit] Error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
