/**
 * Report the leads of each campaign's audience group that the campaign never enrolled.
 *
 * Background: a campaign whose audience is a lead group enrolls the leads that
 * join the group (lib/campaignCohort enrollGroupJoiners). Before M25
 * (2026-09-30) it enrolled none of them, and until 2026-10-01 only while the
 * campaign was Active or Draft. A campaign's audience is synced again only
 * when a save changes it, never when the campaign is resumed, restarted or
 * auto-resumed, so a lead added to a group then, or while the group's
 * campaign was Paused or Stopped, is still not enrolled. Group memberships
 * carry no date, so this script counts every lead of a campaign's group that
 * may be emailed and has no enrollment in the campaign, in campaigns of every
 * status, using the rules in lib/groupEnrollmentBackfill:
 *   - a lead the campaign emailed or had a reply from is left alone, so no
 *     one is sent step 1 twice;
 *   - a campaign whose audience sync has not finished is left alone, as its
 *     next save finishes it.
 * It only reads, and it lists no addresses, only counts.
 *
 * Usage:
 *   npx tsx scripts/backfill-group-enrollments.ts                       # report (no writes)
 *   npx tsx scripts/backfill-group-enrollments.ts --campaign=<id> ...   # only these campaigns
 */
import { PrismaClient } from '@prisma/client';
import { type GroupEnrollmentGap, findGroupEnrollmentGaps } from '../lib/groupEnrollmentBackfill';

const prisma = new PrismaClient();

const args = process.argv.slice(2);
const CAMPAIGN_IDS = args.filter((arg) => arg.startsWith('--campaign=')).map((arg) => arg.slice('--campaign='.length));
const LABEL = '[Group Enrollment Backfill]';

function describeGap(gap: GroupEnrollmentGap): string {
  const group = gap.groupName === null ? `no group has id ${gap.groupId}` : `group "${gap.groupName}"`;
  const head = `"${gap.name}" (${gap.campaignId}) ${gap.status}, ${group}: ${gap.enrollable} may be emailed`;
  if (gap.syncPending) return `${head}; audience sync pending, left alone (its next save finishes it)`;
  const toEnroll = gap.toEnroll.length === 0
    ? 'none to enroll'
    : `${gap.toEnroll.length} to enroll (${gap.status === 'Active' ? 'sent step 1 from its next sending window' : 'sent step 1 once the campaign is Active'})`;
  const contacted = gap.contacted === 0 ? '' : `; ${gap.contacted} emailed or replied before without an enrollment, left alone`;
  return `${head}, ${toEnroll}${contacted}`;
}

async function main() {
  console.log(`${LABEL} Mode: REPORT (no changes)`);

  const gaps = await findGroupEnrollmentGaps(prisma, CAMPAIGN_IDS.length > 0 ? CAMPAIGN_IDS : undefined);
  for (const id of CAMPAIGN_IDS.filter((id) => !gaps.some((gap) => gap.campaignId === id))) {
    console.log(`${LABEL} No campaign with a lead group audience has id ${id}.`);
  }

  const actionable = gaps.filter((gap) => !gap.syncPending && gap.toEnroll.length > 0);
  const toEnroll = actionable.reduce((sum, gap) => sum + gap.toEnroll.length, 0);
  console.log(
    `${LABEL} Campaigns with a lead group audience: ${gaps.length}. ` +
    `Leads to enroll: ${toEnroll}, in ${actionable.length} campaign(s).`
  );
  for (const gap of gaps) console.log(`  ${describeGap(gap)}.`);
}

main()
  .catch((e) => {
    console.error(`${LABEL} Error:`, e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
