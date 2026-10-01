/**
 * Reset campaign history: delete every campaign and everything it sent and
 * recorded, keeping leads, lead groups, templates, mailboxes and the
 * suppression list.
 *
 * Background: the campaigns sent before the 30 Sep 2026 fixes recorded
 * scanner hits as opens and clicks, no unsubscribe events, accepted emails as
 * Failed and no delivery reports, and no fix can correct what they recorded.
 * This clears it so the stats start again from new sends. It deletes, in this
 * order:
 *   1. every email with a campaign or a sequence step (EmailDispatch), per
 *      campaign in committed batches of 5,000, then any with a step and no
 *      campaign; their events (EmailEvent) go with them. Mailbox tests and
 *      Unibox replies (no campaign, no step) stay.
 *   2. every campaign, in one transaction; its steps, enrollments and mailbox
 *      pool go with it. Deleting a campaign first would only blank the campaign
 *      on its emails, which would still count on the dashboard and the Accounts
 *      page, so this is not the app's Delete Campaign.
 * It never deletes a lead, suppression entry, DeletedLead or LeadAlias row,
 * lead group or membership, template, mailbox, user, setting or worker lease.
 * Unsubscribe links in mail already sent keep working (they carry the lead id).
 *
 * Before deleting anything, --apply acts on what only the enrollments record,
 * using the rules in lib/campaignHistoryReset, as each flag says:
 *   --azure-dropped=suppress|keep   leads ACS refused as on its suppression list
 *                                   (EmailDroppedAllRecipientsSuppressed): suppress:
 *                                   HardBounce on the suppression list (source
 *                                   backfill), validation Invalid, status Bounced
 *                                   unless Unsubscribed
 *   --clock-skew=reset|keep         leads still Risky from the 2026-07-06 Azure
 *                                   clock-skew incident: reset: validation Unverified
 *   --save-progress-groups=yes|no   per campaign, the lead groups "<name> - Finished"
 *                                   and "<name> - Contacted, not finished", created or
 *                                   reused by name (a bare --save-progress-groups is yes)
 *
 * Every run first reads the database in one READ ONLY transaction, prints the
 * campaigns, the safety checks, what it would delete (per table and per
 * campaign), what it keeps and the planned lead flag changes, and writes an
 * export to a new folder under --out: enrollments.csv (each lead's enrollment
 * and what its campaign sent it), campaigns.json (settings, mailbox pool, and
 * steps with their copy), lead-flag-changes.csv and summary.json. The export
 * holds email addresses, so --out must be outside the repository; delete it once
 * no longer needed. It never reads the email bodies of EmailDispatch.
 *
 * --apply refuses unless the export was written, every decision flag is given,
 * --expect-dispatches equals the emails it would delete now, no campaign is
 * Active or due to auto-resume, no campaign email is Sending, no enrollment has
 * a send claim from the last 10 minutes and no reply belongs to a campaign. It
 * checks the campaigns and Sending emails again in every batch, and all four
 * again in the campaign delete. Then it runs VACUUM (ANALYZE) on the emptied
 * tables (printing the SQL to run in psql if that fails) and compares every
 * table with its count before, exiting 1 if anything is left to delete or a
 * kept table changed other than by what the lead flag step added.
 *
 * Safe to run again: every step selects by the current state. After a crash,
 * run the dry run again and pass its count to --expect-dispatches; it carries
 * on from where it stopped. Once the reset is done, a run deletes nothing and
 * exits 0. Each run writes a new export folder and never overwrites one.
 *
 * Before --apply: note an Azure point-in-time-restore time (a restore creates a
 * new server), make sure nothing is sending, and run it off-peak.
 *
 * Usage:
 *   npx tsx scripts/reset-campaign-history.ts --out=<dir outside the repo>   # dry run and export (default, no writes)
 *   npx tsx scripts/reset-campaign-history.ts --out=<dir> --apply \
 *       --expect-dispatches=<count from the dry run> \
 *       --azure-dropped=suppress|keep --clock-skew=reset|keep --save-progress-groups=yes|no   # (writes)
 */
import fs from 'fs';
import path from 'path';
import { type Prisma, PrismaClient } from '@prisma/client';
import { toCsv } from '../lib/csv';
import { suppressionReasons } from '../lib/suppression';
import { SEND_CLAIM_TTL_MS } from '../lib/sendEligibility';
import { cohortGroupId } from '../lib/campaignCohort';
import {
  type DispatchGroupRow,
  type FlagEnrollment,
  type LeadFlagChange,
  type ResetOptions,
  type SafetyState,
  type TableCounts,
  ENROLLMENT_EXPORT_COLUMNS,
  FLAGGED_ENROLLMENT_WHERE,
  KEPT_DISPATCH_WHERE,
  KEPT_TABLES,
  LEAD_FLAG_EXPORT_COLUMNS,
  ORPHAN_SEQUENCE_DISPATCH_WHERE,
  RESET_BATCH_SIZE,
  RESET_DISPATCH_WHERE,
  RESET_TABLES,
  afterResetProblems,
  appliedLeadFlagChanges,
  applyLeadFlagChanges,
  applyRefusals,
  countBy,
  countMismatches,
  databaseHost,
  enrollmentExportRows,
  expectedLeadBreakdown,
  isAzureDroppedError,
  isClockSkewError,
  leadFlagExportRows,
  leadStateKey,
  outDirRefusal,
  parseResetArgs,
  planLeadFlagChanges,
  planProgressGroups,
  safetyChecks,
  saveProgressGroups,
  summarizeLeadSends,
} from '../lib/campaignHistoryReset';

const prisma = new PrismaClient();

const LABEL = '[History Reset]';
const REPO_ROOT = path.resolve(__dirname, '..');
/** Prisma's interactive transaction limits; its 5 s default is too short for a batch of 5,000 emails. */
const TX_OPTIONS = { maxWait: 10_000, timeout: 120_000 };
const BATCH_PAUSE_MS = 1000;
/** Most lead ids one lookup names, to stay under Postgres's bind-parameter limit. */
const LEAD_ID_CHUNK = 5000;
const VACUUM_TABLES = ['EmailDispatch', 'EmailEvent', 'CampaignEnrollment', 'CampaignStep', 'Campaign'];
/** Excel reads a CSV as UTF-8 only with a byte order mark, as the app's own CSV downloads have. */
const BOM = '﻿';

type Tx = Prisma.TransactionClient;

/** The repository the script is in, and every repository above it (a worktree sits inside the main checkout). */
function repoRoots(): string[] {
  const roots = [REPO_ROOT];
  for (let dir = path.dirname(REPO_ROOT); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) roots.push(dir);
    if (path.dirname(dir) === dir) return roots;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts);
  return entries.length === 0 ? 'none' : entries.map(([key, n]) => `${key} ${n}`).join(', ');
}

/** Bounds every statement of a writing transaction, so a lock or a slow delete fails the batch instead of hanging. */
async function setLocalTimeouts(tx: Tx): Promise<void> {
  await tx.$executeRaw`SET LOCAL statement_timeout = '60s'`;
  await tx.$executeRaw`SET LOCAL lock_timeout = '10s'`;
}

/** Row counts of what the reset empties and what it keeps, and the leads per status/validation status. */
async function readCounts(tx: Tx): Promise<{ reset: TableCounts; kept: TableCounts; leads: TableCounts }> {
  const reset: TableCounts = {
    'EmailDispatch (with a campaign or step)': await tx.emailDispatch.count({ where: RESET_DISPATCH_WHERE }),
    'EmailEvent (on those emails)': await tx.emailEvent.count({ where: { dispatch: RESET_DISPATCH_WHERE } }),
    Campaign: await tx.campaign.count(),
    CampaignStep: await tx.campaignStep.count(),
    CampaignEnrollment: await tx.campaignEnrollment.count(),
    CampaignSenderAccount: await tx.campaignSenderAccount.count(),
  };
  const kept: TableCounts = {
    Lead: await tx.lead.count(),
    SuppressedEmail: await tx.suppressedEmail.count(),
    DeletedLead: await tx.deletedLead.count(),
    LeadAlias: await tx.leadAlias.count(),
    LeadGroup: await tx.leadGroup.count(),
    LeadGroupMembership: await tx.leadGroupMembership.count(),
    Template: await tx.template.count(),
    SenderAccount: await tx.senderAccount.count(),
    User: await tx.user.count(),
    GlobalSettings: await tx.globalSettings.count(),
    WorkerLease: await tx.workerLease.count(),
    InboundResponse: await tx.inboundResponse.count(),
    'EmailDispatch (no campaign or step)': await tx.emailDispatch.count({ where: KEPT_DISPATCH_WHERE }),
    'EmailEvent (on kept emails)': await tx.emailEvent.count({ where: { dispatch: KEPT_DISPATCH_WHERE } }),
  };
  const leadGroups = await tx.lead.groupBy({ by: ['status', 'validationStatus'], _count: { _all: true } });
  const leads = Object.fromEntries(leadGroups.map((group) => [leadStateKey(group), group._count._all]));
  return { reset, kept, leads };
}

/** What the safety checks read (lib/campaignHistoryReset safetyChecks). */
async function readSafetyState(tx: Tx): Promise<SafetyState> {
  const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
  return {
    campaigns: await tx.campaign.findMany({ select: { name: true, status: true, pausedUntil: true }, orderBy: { name: 'asc' } }),
    sendingEmails: await tx.emailDispatch.count({ where: { AND: [RESET_DISPATCH_WHERE, { status: 'Sending' }] } }),
    recentClaims: await tx.campaignEnrollment.count({ where: { claimedAt: { gte: new Date(now.getTime() - SEND_CLAIM_TTL_MS) } } }),
    campaignReplies: await tx.inboundResponse.count({ where: { campaignId: { not: null } } }),
  };
}

/** What each campaign sent each lead (never the email bodies). */
async function readLeadSends(tx: Tx) {
  const rows = await tx.emailDispatch.groupBy({
    by: ['campaignId', 'leadId', 'status'],
    where: { campaignId: { not: null }, leadId: { not: null } },
    _count: { _all: true },
    _max: { stepOrder: true, sentAt: true },
  });
  return summarizeLeadSends(rows as DispatchGroupRow[]);
}

/** The highest stepOrder of a campaign's steps, null when it has none. */
function lastStep(steps: { stepOrder: number }[]): number | null {
  return steps.length === 0 ? null : Math.max(...steps.map((step) => step.stepOrder));
}

/** Runs `read` in one READ ONLY transaction, so it can write nothing and sees one consistent picture. */
async function readOnly<T>(read: (tx: Tx) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    // Must be the transaction's first statement
    await tx.$executeRaw`SET TRANSACTION READ ONLY, ISOLATION LEVEL REPEATABLE READ`;
    const [mode] = await tx.$queryRaw<{ readOnly: string }[]>`SELECT current_setting('transaction_read_only') AS "readOnly"`;
    if (mode.readOnly !== 'on') throw new Error('Could not make the transaction read-only.');
    await tx.$executeRaw`SET LOCAL statement_timeout = '60s'`;
    return read(tx);
  }, TX_OPTIONS);
}

/** Everything the dry run reads, in one READ ONLY transaction. */
async function survey() {
  return readOnly(async (tx) => {
    const at = new Date();
    const campaigns = await tx.campaign.findMany({
      orderBy: { name: 'asc' },
      include: {
        user: { select: { email: true } },
        senderAccount: { select: { emailAddress: true } },
        senders: { select: { senderAccountId: true, senderAccount: { select: { emailAddress: true } } } },
        steps: { orderBy: { stepOrder: 'asc' }, select: { stepOrder: true, waitDays: true, subject: true, body: true } },
      },
    });
    const audienceGroups = await tx.leadGroup.findMany({
      where: { id: { in: campaigns.map((campaign) => cohortGroupId(campaign.audienceCohort)) } },
      select: { id: true, name: true },
    });

    const emailsByStatus = await tx.emailDispatch.groupBy({
      by: ['campaignId', 'status'],
      where: RESET_DISPATCH_WHERE,
      _count: { _all: true },
    });
    const enrollmentsByStatus = await tx.campaignEnrollment.groupBy({ by: ['campaignId', 'status'], _count: { _all: true } });
    const events = new Map<string, number>();
    for (const campaign of campaigns) {
      events.set(campaign.id, await tx.emailEvent.count({ where: { dispatch: { campaignId: campaign.id } } }));
    }
    const orphanEvents = await tx.emailEvent.count({ where: { dispatch: ORPHAN_SEQUENCE_DISPATCH_WHERE } });

    const enrollments = await tx.campaignEnrollment.findMany({
      select: {
        leadId: true, campaignId: true, status: true, currentSequenceStep: true, retryCount: true,
        lastError: true, lastBounceType: true, enrolledAt: true,
        lead: { select: { email: true, status: true, validationStatus: true } },
      },
      orderBy: [{ campaignId: 'asc' }, { enrolledAt: 'asc' }, { leadId: 'asc' }],
    });
    const sends = await readLeadSends(tx);

    // Addresses of leads a campaign emailed without an enrollment, for the export
    const enrolled = new Set(enrollments.map((e) => e.leadId));
    const unenrolled = [...new Set([...sends.values()].flatMap((leads) => [...leads.keys()]))].filter((id) => !enrolled.has(id));
    const emails = new Map<string, string>();
    for (let i = 0; i < unenrolled.length; i += LEAD_ID_CHUNK) {
      const leads = await tx.lead.findMany({ where: { id: { in: unenrolled.slice(i, i + LEAD_ID_CHUNK) } }, select: { id: true, email: true } });
      for (const lead of leads) emails.set(lead.id, lead.email);
    }

    const names = new Map(campaigns.map((campaign) => [campaign.id, campaign.name]));
    const flagged: FlagEnrollment[] = enrollments
      .filter((e) => isAzureDroppedError(e.lastError) || isClockSkewError(e.lastError))
      .map((e) => ({ leadId: e.leadId, campaignName: names.get(e.campaignId) ?? e.campaignId, status: e.status, lastError: e.lastError, lead: e.lead }));
    const flagChanges = planLeadFlagChanges(flagged, await suppressionReasons(tx, flagged.map((e) => e.lead.email)));

    const groupPlans = planProgressGroups(
      campaigns.map((campaign) => ({ id: campaign.id, name: campaign.name, lastStep: lastStep(campaign.steps) })),
      enrollments,
      sends,
      at.toISOString().slice(0, 10),
    );
    const existingGroups = new Set((await tx.leadGroup.findMany({
      where: { name: { in: groupPlans.map((plan) => plan.name) } },
      select: { name: true },
    })).map((group) => group.name));

    return {
      at,
      campaigns,
      audienceGroups: new Map(audienceGroups.map((group) => [group.id, group.name])),
      emailsByStatus,
      enrollmentsByStatus,
      events,
      orphanEvents,
      enrollments,
      sends,
      emails,
      flagChanges,
      groupPlans,
      existingGroups,
      counts: await readCounts(tx),
      safety: await readSafetyState(tx),
    };
  });
}

type Survey = Awaited<ReturnType<typeof survey>>;

/** One campaign's share of what is deleted: emails by status, events, steps, enrollments by status and pool. */
function campaignCounts(s: Survey, campaignId: string | null) {
  const emails = Object.fromEntries(s.emailsByStatus.filter((g) => g.campaignId === campaignId).map((g) => [g.status, g._count._all]));
  const enrollments = Object.fromEntries(s.enrollmentsByStatus.filter((g) => g.campaignId === campaignId).map((g) => [g.status, g._count._all]));
  const sum = (counts: Record<string, number>) => Object.values(counts).reduce((total, n) => total + n, 0);
  return {
    emails: sum(emails),
    emailsByStatus: emails,
    events: campaignId === null ? s.orphanEvents : s.events.get(campaignId) ?? 0,
    enrollments: sum(enrollments),
    enrollmentsByStatus: enrollments,
  };
}

function flagSummary(changes: LeadFlagChange[]) {
  return {
    leads: changes.length,
    toChange: changes.filter((change) => change.changes).length,
    byCurrentState: countBy(changes, (change) => leadStateKey(change.current)),
    byEnrollmentStatus: countBy(changes.flatMap((change) => change.enrollmentStatuses), (status) => status),
  };
}

function report(s: Survey, options: ResetOptions): void {
  const verb = options.apply ? 'To delete' : 'Would delete';
  console.log(`${LABEL} Campaigns: ${s.campaigns.length}.`);
  for (const campaign of s.campaigns) {
    const paused = campaign.pauseReason ? ` (pause reason: ${campaign.pauseReason})` : '';
    const resume = campaign.pausedUntil ? campaign.pausedUntil.toISOString() : 'none';
    console.log(`  "${campaign.name}" (${campaign.id}) ${campaign.status}${paused}, auto-resume: ${resume}`);
  }

  console.log(`${LABEL} Safety checks for --apply:`);
  for (const check of safetyChecks(s.safety)) console.log(`  ${check.ok ? 'PASS' : 'FAIL'} ${check.label}${check.ok ? '' : ` (${check.detail})`}`);

  console.log(`${LABEL} ${verb}:`);
  for (const table of RESET_TABLES) console.log(`  ${table}: ${s.counts.reset[table]}`);
  console.log('  Per campaign:');
  for (const campaign of s.campaigns) {
    const c = campaignCounts(s, campaign.id);
    console.log(
      `    "${campaign.name}": ${c.emails} emails (${formatCounts(c.emailsByStatus)}), ${c.events} events, ` +
      `${campaign.steps.length} steps, ${c.enrollments} enrollments (${formatCounts(c.enrollmentsByStatus)}), ` +
      `${campaign.senders.length} pool mailbox(es)`
    );
  }
  const orphans = campaignCounts(s, null);
  console.log(`    With a step and no campaign: ${orphans.emails} emails (${formatCounts(orphans.emailsByStatus)}), ${orphans.events} events`);

  console.log(`${LABEL} Kept:`);
  for (const table of KEPT_TABLES) console.log(`  ${table}: ${s.counts.kept[table]}`);
  console.log(`  Leads by status/validation: ${formatCounts(s.counts.leads)}`);

  const azure = flagSummary(s.flagChanges.filter((change) => change.kind === 'azure-dropped'));
  const clock = flagSummary(s.flagChanges.filter((change) => change.kind === 'clock-skew'));
  console.log(`${LABEL} Lead flags (only the enrollments record these, so they are handled before the delete):`);
  console.log(
    `  Azure dropped (lastError AllRecipientsSuppressed): ${azure.leads} leads, ${azure.toChange} to change. ` +
    `Now: ${formatCounts(azure.byCurrentState)}. Enrollments: ${formatCounts(azure.byEnrollmentStatus)}.`
  );
  console.log(
    `    --azure-dropped=suppress adds them to the suppression list as HardBounce (source backfill) and sets validation Invalid, ` +
    `and status Bounced unless Unsubscribed. Given: ${options.azureDropped ?? 'not given'}.`
  );
  console.log(
    `  Clock skew, still Risky (lastError "time difference between the originating client"): ${clock.leads} leads, ` +
    `${clock.toChange} to change. Now: ${formatCounts(clock.byCurrentState)}. Enrollments: ${formatCounts(clock.byEnrollmentStatus)}.`
  );
  console.log(`    --clock-skew=reset sets validation Unverified. Given: ${options.clockSkew ?? 'not given'}.`);

  const groupsGiven = options.saveProgressGroups === null ? 'not given' : options.saveProgressGroups ? 'yes' : 'no';
  console.log(`${LABEL} Progress groups (--save-progress-groups=yes; given: ${groupsGiven}):`);
  if (s.groupPlans.length === 0) console.log('  None: no campaign emailed or finished anyone.');
  for (const plan of s.groupPlans) {
    console.log(`  "${plan.name}": ${plan.leadIds.length} leads (${s.existingGroups.has(plan.name) ? 'group exists; leads already in it are skipped' : 'new group'})`);
  }
}

/** Writes the export to a new folder under --out and returns its path. Never overwrites a file. */
function writeExport(s: Survey, options: ResetOptions, host: string): string {
  const parent = path.resolve(options.out);
  fs.mkdirSync(parent, { recursive: true });
  const dir = path.join(parent, `campaign-history-${s.at.toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(dir);
  const write = (name: string, content: string) =>
    fs.writeFileSync(path.join(dir, name), content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });

  const names = new Map(s.campaigns.map((campaign) => [campaign.id, campaign.name]));
  write('enrollments.csv', BOM + toCsv(enrollmentExportRows(s.enrollments, s.sends, names, s.emails), ENROLLMENT_EXPORT_COLUMNS));

  write('campaigns.json', JSON.stringify(s.campaigns.map((campaign) => ({
    id: campaign.id,
    name: campaign.name,
    status: campaign.status,
    owner: campaign.user.email,
    createdAt: campaign.createdAt,
    updatedAt: campaign.updatedAt,
    pausedUntil: campaign.pausedUntil,
    pauseReason: campaign.pauseReason,
    stoppedAt: campaign.stoppedAt,
    timezone: campaign.timezone,
    sendSchedule: campaign.sendSchedule,
    stopOnReply: campaign.stopOnReply,
    trackOpens: campaign.trackOpens,
    trackClicks: campaign.trackClicks,
    audienceCohort: campaign.audienceCohort,
    audienceGroup: s.audienceGroups.get(cohortGroupId(campaign.audienceCohort)) ?? null,
    cohortSyncRequestedAt: campaign.cohortSyncRequestedAt,
    mailbox: { id: campaign.senderAccountId, emailAddress: campaign.senderAccount.emailAddress },
    mailboxPool: campaign.senders.map((sender) => ({ id: sender.senderAccountId, emailAddress: sender.senderAccount.emailAddress })),
    steps: campaign.steps,
    deleted: campaignCounts(s, campaign.id),
  })), null, 2));

  write('lead-flag-changes.csv', BOM + toCsv(leadFlagExportRows(s.flagChanges, options), LEAD_FLAG_EXPORT_COLUMNS));
  write('summary.json', JSON.stringify(summaryJson(s, options, host), null, 2));
  return dir;
}

function summaryJson(s: Survey, options: ResetOptions, host: string) {
  return {
    generatedAt: s.at,
    databaseHost: host,
    mode: options.apply ? 'apply' : 'dry-run',
    options: { ...options, out: path.resolve(options.out) },
    campaigns: s.campaigns.map((campaign) => ({
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      pausedUntil: campaign.pausedUntil,
      steps: campaign.steps.length,
      mailboxPool: campaign.senders.length,
      ...campaignCounts(s, campaign.id),
    })),
    sequenceEmailsWithNoCampaign: campaignCounts(s, null),
    toDelete: s.counts.reset,
    kept: s.counts.kept,
    leadsByStatusAndValidation: s.counts.leads,
    safetyChecks: safetyChecks(s.safety),
    leadFlags: {
      azureDropped: flagSummary(s.flagChanges.filter((change) => change.kind === 'azure-dropped')),
      clockSkew: flagSummary(s.flagChanges.filter((change) => change.kind === 'clock-skew')),
    },
    progressGroups: s.groupPlans.map((plan) => ({ name: plan.name, leads: plan.leadIds.length, exists: s.existingGroups.has(plan.name) })),
  };
}

/** Step 1: the lead flags and progress groups, in one transaction, selected again by the current state. */
async function applyLeadFlags(options: ResetOptions) {
  return prisma.$transaction(async (tx) => {
    await setLocalTimeouts(tx);
    const enrollments = await tx.campaignEnrollment.findMany({
      where: FLAGGED_ENROLLMENT_WHERE,
      select: {
        leadId: true, status: true, lastError: true,
        campaign: { select: { name: true } },
        lead: { select: { email: true, status: true, validationStatus: true } },
      },
      orderBy: [{ campaignId: 'asc' }, { leadId: 'asc' }],
    });
    const flagged: FlagEnrollment[] = enrollments.map((e) => ({ ...e, campaignName: e.campaign.name }));
    const changes = planLeadFlagChanges(flagged, await suppressionReasons(tx, flagged.map((e) => e.lead.email)));
    const decisions = { azureDropped: options.azureDropped ?? 'keep', clockSkew: options.clockSkew ?? 'keep' } as const;
    const written = await applyLeadFlagChanges(tx, changes, decisions);

    let groups: { name: string; created: boolean; added: number }[] = [];
    if (options.saveProgressGroups) {
      const campaigns = await tx.campaign.findMany({ select: { id: true, name: true, steps: { select: { stepOrder: true } } } });
      const plans = planProgressGroups(
        campaigns.map((campaign) => ({ id: campaign.id, name: campaign.name, lastStep: lastStep(campaign.steps) })),
        await tx.campaignEnrollment.findMany({ select: { campaignId: true, leadId: true, status: true } }),
        await readLeadSends(tx),
        new Date().toISOString().slice(0, 10),
      );
      groups = await saveProgressGroups(tx, plans);
    }
    return { applied: appliedLeadFlagChanges(changes, decisions), written, groups };
  }, TX_OPTIONS);
}

/** Checks 4 and 5 again: no campaign is Active or due to auto-resume, and no campaign email is Sending. */
async function assertNothingSending(tx: Tx): Promise<void> {
  const live = await tx.campaign.findMany({
    where: { OR: [{ status: 'Active' }, { pausedUntil: { not: null } }] },
    select: { name: true },
  });
  const sending = await tx.emailDispatch.count({ where: { AND: [RESET_DISPATCH_WHERE, { status: 'Sending' }] } });
  if (live.length > 0 || sending > 0) {
    throw new Error(
      `Stopped before this batch: ${live.length > 0 ? `${live.map((c) => `"${c.name}"`).join(', ')} is Active or due to auto-resume` : ''}` +
      `${live.length > 0 && sending > 0 ? '; ' : ''}${sending > 0 ? `${sending} campaign emails are Sending` : ''}. ` +
      'Pause the campaigns, wait for the sends to settle, then run the dry run again.'
    );
  }
}

/**
 * Step 2: deletes the emails matching `where`, up to RESET_BATCH_SIZE per
 * committed transaction, with a pause between batches. Their events go with
 * them (EmailEvent cascades). Selects ids only, never the bodies.
 */
async function deleteEmailsInBatches(label: string, where: Prisma.EmailDispatchWhereInput, progress: { done: number; total: number }): Promise<number> {
  let deleted = 0;
  for (;;) {
    const count = await prisma.$transaction(async (tx) => {
      await setLocalTimeouts(tx);
      await assertNothingSending(tx);
      const batch = await tx.emailDispatch.findMany({ where, select: { id: true }, take: RESET_BATCH_SIZE });
      if (batch.length === 0) return 0;
      const result = await tx.emailDispatch.deleteMany({ where: { AND: [where, { id: { in: batch.map((row) => row.id) } }] } });
      if (result.count === 0) throw new Error(`${label}: a batch of ${batch.length} emails deleted none.`);
      return result.count;
    }, TX_OPTIONS);
    if (count === 0) return deleted;
    deleted += count;
    progress.done += count;
    console.log(`  ${label}: deleted ${count} (${deleted} for it, ${progress.done} of ${progress.total} in all)`);
    if (count === RESET_BATCH_SIZE) await sleep(BATCH_PAUSE_MS);
  }
}

/**
 * Step 3: deletes the campaigns the dry run listed, with their steps,
 * enrollments and mailbox pool, once no email points at one, the campaign rows
 * are locked and every safety check passes again.
 */
async function deleteCampaigns(campaignIds: string[]): Promise<number> {
  return prisma.$transaction(async (tx) => {
    await setLocalTimeouts(tx);
    const locked = await tx.$queryRaw<{ id: string; name: string }[]>`SELECT id, name FROM "Campaign" ORDER BY id FOR UPDATE`;
    const added = locked.filter((campaign) => !campaignIds.includes(campaign.id));
    if (added.length > 0) {
      throw new Error(`Campaigns created during the run: ${added.map((c) => `"${c.name}"`).join(', ')}. Nothing was deleted from Campaign; run the dry run again.`);
    }
    const failed = safetyChecks(await readSafetyState(tx)).filter((check) => !check.ok);
    if (failed.length > 0) throw new Error(`Safety check failed: ${failed.map((check) => `${check.label} (${check.detail})`).join('; ')}.`);
    const left = await tx.emailDispatch.count({ where: RESET_DISPATCH_WHERE });
    if (left > 0) throw new Error(`${left} emails with a campaign or step are still there; run the dry run again.`);
    const { count } = await tx.campaign.deleteMany({ where: { id: { in: locked.map((campaign) => campaign.id) } } });
    return count;
  }, TX_OPTIONS);
}

/** Step 4: VACUUM (ANALYZE) on each emptied table, outside any transaction. Returns the statements that failed. */
async function vacuum(): Promise<string[]> {
  const failed: string[] = [];
  for (const table of VACUUM_TABLES) {
    const sql = `VACUUM (ANALYZE) "${table}"`;
    try {
      await prisma.$executeRawUnsafe(sql);
      console.log(`  ${sql}: done`);
    } catch (e) {
      failed.push(sql);
      console.log(`  ${sql}: failed (${e instanceof Error ? e.message.split('\n')[0] : e})`);
    }
  }
  if (failed.length > 0) console.log(`  Run this in psql: ${failed.map((sql) => `${sql};`).join(' ')}`);
  return failed;
}

function printComparison(rows: [string, number, number, number][]): void {
  const width = Math.max(...rows.map(([name]) => name.length), 5);
  console.log(`  ${'Table'.padEnd(width)}  ${'Before'.padStart(8)}  ${'After'.padStart(8)}  ${'Expected'.padStart(8)}`);
  for (const [name, before, after, expected] of rows) {
    console.log(`  ${name.padEnd(width)}  ${String(before).padStart(8)}  ${String(after).padStart(8)}  ${String(expected).padStart(8)}${after === expected ? '' : '  <- unexpected'}`);
  }
}

async function applyReset(s: Survey, options: ResetOptions, exportDir: string): Promise<boolean> {
  console.log(`${LABEL} Step 1 of 5: lead flags and progress groups.`);
  const flags = await applyLeadFlags(options);
  console.log(
    options.azureDropped === 'suppress'
      ? `  Azure dropped: ${flags.written.suppressed} address(es) added to the suppression list; ${flags.written.bounced} lead(s) set to Bounced/Invalid, ` +
        `${flags.written.invalidOnly} Unsubscribed lead(s) set to Invalid.`
      : '  Azure dropped: left as they are (--azure-dropped=keep).'
  );
  console.log(options.clockSkew === 'reset' ? `  Clock skew: ${flags.written.unverified} lead(s) set to Unverified.` : '  Clock skew: left as they are (--clock-skew=keep).');
  if (!options.saveProgressGroups) console.log('  Progress groups: not saved (--save-progress-groups=no).');
  for (const group of flags.groups) console.log(`  Group "${group.name}": ${group.created ? 'created' : 'already there'}, ${group.added} lead(s) added.`);

  console.log(`${LABEL} Step 2 of 5: emails, ${RESET_BATCH_SIZE} per batch.`);
  const progress = { done: 0, total: s.counts.reset['EmailDispatch (with a campaign or step)'] };
  for (const campaign of s.campaigns) {
    await deleteEmailsInBatches(`"${campaign.name}"`, { campaignId: campaign.id }, progress);
  }
  await deleteEmailsInBatches('With a step and no campaign', ORPHAN_SEQUENCE_DISPATCH_WHERE, progress);
  console.log(`  Deleted ${progress.done} email(s).`);

  console.log(`${LABEL} Step 3 of 5: campaigns.`);
  const campaigns = await deleteCampaigns(s.campaigns.map((campaign) => campaign.id));
  console.log(`  Deleted ${campaigns} campaign(s), with their steps, enrollments and mailbox pools.`);

  console.log(`${LABEL} Step 4 of 5: VACUUM (ANALYZE).`);
  const vacuumFailed = await vacuum();

  console.log(`${LABEL} Step 5 of 5: before and after.`);
  const after = await readOnly(readCounts);
  const added: TableCounts = {
    SuppressedEmail: flags.written.suppressed,
    LeadGroup: flags.groups.filter((group) => group.created).length,
    LeadGroupMembership: flags.groups.reduce((total, group) => total + group.added, 0),
  };
  printComparison([
    ...RESET_TABLES.map((table): [string, number, number, number] => [table, s.counts.reset[table], after.reset[table], 0]),
    ...KEPT_TABLES.map((table): [string, number, number, number] => [table, s.counts.kept[table], after.kept[table], s.counts.kept[table] + (added[table] ?? 0)]),
  ]);
  const expectedLeads = expectedLeadBreakdown(s.counts.leads, flags.applied);
  console.log(`  Leads by status/validation before: ${formatCounts(s.counts.leads)}`);
  console.log(`  Leads by status/validation after:  ${formatCounts(after.leads)}`);
  const problems = [
    ...afterResetProblems(s.counts, after, added),
    ...countMismatches(expectedLeads, after.leads).map((mismatch) => `Leads ${mismatch}`),
  ];

  const summaryPath = path.join(exportDir, 'summary.json');
  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  summary.apply = {
    finishedAt: new Date(),
    leadFlags: flags.written,
    leadFlagChangesApplied: flags.applied.length,
    progressGroups: flags.groups,
    emailsDeleted: progress.done,
    campaignsDeleted: campaigns,
    vacuumFailed,
    after,
    expectedLeadsByStatusAndValidation: expectedLeads,
    problems,
  };
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

  if (problems.length > 0) {
    console.log(`${LABEL} FAILED checks after the reset:`);
    for (const problem of problems) console.log(`  ${problem}`);
    return false;
  }
  console.log(`${LABEL} Done. No email with a campaign or step, no campaign and no event on a deleted email is left, and every kept table is as expected.`);
  return true;
}

async function main() {
  const parsed = parseResetArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(`${LABEL} ${parsed.error}`);
    process.exitCode = 1;
    return;
  }
  const { options } = parsed;
  const outRefusal = outDirRefusal(options.out, repoRoots());
  if (outRefusal) {
    console.error(`${LABEL} ${outRefusal}`);
    process.exitCode = 1;
    return;
  }
  // Read after PrismaClient has loaded .env, so this is the database it connects to
  const host = databaseHost(process.env.DATABASE_URL);
  if (!host) {
    console.error(`${LABEL} DATABASE_URL is not set or is not a URL.`);
    process.exitCode = 1;
    return;
  }

  console.log(`${LABEL} Mode: ${options.apply ? 'APPLY (writes)' : 'DRY-RUN (no changes)'}`);
  console.log(`${LABEL} Database host: ${host}`);

  const s = await survey();
  report(s, options);
  const exportDir = writeExport(s, options, host);
  console.log(`${LABEL} Export written to ${exportDir}. It holds email addresses: keep it out of the repository and delete it once no longer needed.`);

  const resetDispatches = s.counts.reset['EmailDispatch (with a campaign or step)'];
  if (!options.apply) {
    console.log(
      `${LABEL} Dry run. To apply, after noting a restore point and making sure nothing is sending:\n` +
      `  npx tsx scripts/reset-campaign-history.ts --out=${options.out} --apply --expect-dispatches=${resetDispatches} ` +
      '--azure-dropped=suppress|keep --clock-skew=reset|keep --save-progress-groups=yes|no'
    );
    return;
  }

  const refusals = applyRefusals({
    options,
    exportWritten: true,
    resetDispatches,
    campaignCount: s.campaigns.length,
    checks: safetyChecks(s.safety),
  });
  if (refusals.length > 0) {
    console.error(`${LABEL} Refusing to apply; nothing was changed:`);
    for (const refusal of refusals) console.error(`  ${refusal}`);
    process.exitCode = 1;
    return;
  }
  if (resetDispatches === 0 && s.campaigns.length === 0) {
    console.log(`${LABEL} Nothing left to reset: no campaign and no email with a campaign or step.`);
    return;
  }
  if (!(await applyReset(s, options, exportDir))) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(`${LABEL} Error:`, e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
