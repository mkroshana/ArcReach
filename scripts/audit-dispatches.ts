/**
 * Audit & clean up EmailDispatch rows.
 *
 * Background: a dispatch row used to be written for every send *attempt*
 * (before the send, and never removed on failure), with no step or status, and
 * repeated manual campaign runs could re-send the same step to the same lead.
 * Rows without a stepOrder are left out of the sequence metrics
 * (lib/engagementMetrics). This script reports, and on request fixes, both,
 * using the rules in lib/dispatchAudit:
 *   - --backfill sets stepOrder on a legacy row when its subject matches
 *     exactly one of the campaign's steps and no other row of the lead has or
 *     infers that step. The subject match can mistake a follow-up for step 1,
 *     so rows that match several steps, or share their step with another row,
 *     are listed and left alone.
 *   - --fix deletes extra 'Sent' dispatches for the same (campaign, lead,
 *     stored step). Of a lead's Sent rows for a step it keeps the one with
 *     events, else with a delivery report, else with a provider id, else the
 *     earliest. It never deletes a row with events, a Failed, Sending or
 *     Unknown row (a retried step leaves a Failed attempt before its Sent row),
 *     or a row whose step is only inferred. A deleted row's tracked links show
 *     Link Unavailable unless they go to a PRE_RESET_LINK_DOMAINS domain
 *     (lib/emailTracking); its unsubscribe link still works.
 * Each write re-checks its row: a backfill only sets a step that is still
 * empty, and a delete only takes a row still Sent with no events. Neither flag
 * leaves anything a later --fix would delete, so running it again is safe.
 *
 * Usage:
 *   npx tsx scripts/audit-dispatches.ts                 # dry-run report only (default, no writes)
 *   npx tsx scripts/audit-dispatches.ts --backfill      # set stepOrder on legacy rows (writes)
 *   npx tsx scripts/audit-dispatches.ts --fix           # delete duplicate Sent rows (writes)
 *   npx tsx scripts/audit-dispatches.ts --backfill --fix
 */
import { PrismaClient } from '@prisma/client';
import { type AuditDispatchRow, type DuplicateGroup, type InferredStep, planDispatchAudit } from '../lib/dispatchAudit';

const prisma = new PrismaClient();

const args = new Set(process.argv.slice(2));
const DO_FIX = args.has('--fix');
const DO_BACKFILL = args.has('--backfill');
const LIST_LIMIT = 50;

function listRows<T>(rows: T[], describe: (row: T) => string): void {
  for (const row of rows.slice(0, LIST_LIMIT)) console.log(`  ${describe(row)}`);
  if (rows.length > LIST_LIMIT) console.log(`  ... and ${rows.length - LIST_LIMIT} more.`);
}

function describeRow(row: AuditDispatchRow): string {
  return `${row.id} (${row.status}, ${row.sentAt.toISOString()}, ${row.eventCount} event(s)) "${row.subject ?? ''}"`;
}

async function main() {
  console.log(`\n=== EmailDispatch audit ===`);
  console.log(`Mode: ${DO_FIX || DO_BACKFILL ? 'WRITE' : 'DRY-RUN (no changes)'}` +
    `${DO_BACKFILL ? ' [+backfill stepOrder]' : ''}${DO_FIX ? ' [+delete duplicate Sent rows]' : ''}\n`);

  const totalRows = await prisma.emailDispatch.count();
  const byStatus = await prisma.emailDispatch.groupBy({ by: ['status'], _count: { id: true } });
  console.log(`Total dispatch rows: ${totalRows}`);
  for (const s of byStatus) console.log(`  status="${s.status}": ${s._count.id}`);

  const campaigns = await prisma.campaign.findMany({
    include: { steps: { orderBy: { stepOrder: 'asc' } } },
  });

  const backfill: (InferredStep & { campaign: string })[] = [];
  const ambiguous: { row: AuditDispatchRow; campaign: string }[] = [];
  const inferredCollisions: (InferredStep & { campaign: string })[] = [];
  const duplicates: (DuplicateGroup & { campaign: string })[] = [];

  for (const campaign of campaigns) {
    const dispatches = await prisma.emailDispatch.findMany({
      where: { campaignId: campaign.id },
      orderBy: { sentAt: 'asc' },
      select: {
        id: true,
        leadId: true,
        subject: true,
        stepOrder: true,
        status: true,
        sentAt: true,
        messageId: true,
        operationId: true,
        deliveredAt: true,
        deliveryStatus: true,
        bouncedAt: true,
        _count: { select: { events: true } },
      },
    });
    if (dispatches.length === 0) continue;

    const rows: AuditDispatchRow[] = dispatches.map(({ _count, ...d }) => ({ ...d, eventCount: _count.events }));
    const plan = planDispatchAudit(campaign.id, campaign.steps, rows);
    const label = `"${campaign.name}" (${campaign.id})`;
    backfill.push(...plan.backfill.map((b) => ({ ...b, campaign: label })));
    ambiguous.push(...plan.ambiguous.map((row) => ({ row, campaign: label })));
    inferredCollisions.push(...plan.inferredCollisions.map((c) => ({ ...c, campaign: label })));
    duplicates.push(...plan.duplicates.map((group) => ({ ...group, campaign: label })));
  }

  const toDelete = duplicates.flatMap((group) => group.remove);
  const withEvents = duplicates.flatMap((group) => group.keepWithEvents);

  console.log(`\n--- Legacy rows (no stored step) ---`);
  console.log(`Step inferred from the subject, set by --backfill: ${backfill.length}`);
  listRows(backfill, (b) => `${b.campaign} lead ${b.row.leadId}: ${describeRow(b.row)} -> step ${b.stepOrder}`);
  console.log(`Subject matches more than one step (left alone): ${ambiguous.length}`);
  listRows(ambiguous, (a) => `${a.campaign} lead ${a.row.leadId}: ${describeRow(a.row)}`);
  console.log(`Inferred step another row of the lead has or infers (left alone, never deleted): ${inferredCollisions.length}`);
  listRows(inferredCollisions, (c) => `${c.campaign} lead ${c.row.leadId} step ${c.stepOrder}: ${describeRow(c.row)}`);

  console.log(`\n--- Duplicate Sent rows (same campaign, lead and stored step) ---`);
  console.log(`Leads with more than one Sent row for a step: ${duplicates.length}. ` +
    `Rows --fix deletes: ${toDelete.length}. Extra rows kept because they have events: ${withEvents.length}.`);
  listRows(duplicates, (group) =>
    `${group.campaign} lead ${group.leadId} step ${group.stepOrder}: keep ${group.keep.id} (${group.keepReason})` +
    `${group.remove.length > 0 ? `; delete ${group.remove.map((row) => row.id).join(', ')}` : ''}` +
    `${group.keepWithEvents.length > 0 ? `; keep (has events) ${group.keepWithEvents.map((row) => row.id).join(', ')}` : ''}`
  );

  if (DO_BACKFILL) {
    console.log(`\nBackfilling stepOrder on ${backfill.length} row(s)...`);
    let backfilled = 0;
    for (const b of backfill) {
      const res = await prisma.emailDispatch.updateMany({
        where: { id: b.row.id, stepOrder: null },
        data: { stepOrder: b.stepOrder },
      });
      backfilled += res.count;
    }
    console.log(`Backfilled ${backfilled} row(s).`);
  } else if (backfill.length > 0) {
    console.log(`\n(Run with --backfill to write these inferred stepOrder values.)`);
  }

  if (DO_FIX) {
    console.log(`\nDeleting ${toDelete.length} duplicate Sent row(s) without events...`);
    let deleted = 0;
    const batchSize = 500;
    for (let i = 0; i < toDelete.length; i += batchSize) {
      const batch = toDelete.slice(i, i + batchSize).map((row) => row.id);
      // Re-checked here, so a row that left Sent or gained an event since it was read stays.
      const res = await prisma.emailDispatch.deleteMany({
        where: { id: { in: batch }, status: 'Sent', events: { none: {} } },
      });
      deleted += res.count;
    }
    console.log(`Deleted ${deleted} duplicate row(s).`);
  } else if (toDelete.length > 0) {
    console.log(`\n(Run with --fix to delete these duplicate Sent rows, keeping the listed row for each step.)`);
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
