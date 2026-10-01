import path from 'path';
import type { LeadStatus, LeadValidationStatus, Prisma, SuppressionReason } from '@prisma/client';
import { normalizeEmail } from './leadEmail';
import { suppressEmails } from './suppression';

/**
 * Rules for scripts/reset-campaign-history.ts, which deletes every campaign
 * and everything it sent and recorded (its emails and their events, steps,
 * enrollments and mailbox pool) while keeping leads, lead groups, templates,
 * mailboxes and the suppression list.
 *
 * Before the enrollments go, it can act on what only they record, in the
 * enrollment's lastError:
 *   - azure-dropped: ACS refused a send because the address is on its own
 *     suppression list (EmailDroppedAllRecipientsSuppressed). The address is
 *     undeliverable, so it goes on the suppression list as a hard bounce
 *     (source 'backfill') and the lead becomes Bounced and Invalid, as the send
 *     engine now does after one such refusal. A lead that unsubscribed stays
 *     Unsubscribed.
 *   - clock-skew: the 2026-07-06 Azure clock-skew incident, which the send
 *     engine of the time took for a fault of each lead and marked it Risky.
 *     A lead still Risky goes back to Unverified. A lead that also has an
 *     azure-dropped error is left alone, since its address is known to be bad.
 *   - progress groups: per campaign, a lead group of the leads that finished
 *     it and one of those it emailed that had not, so a new campaign can leave
 *     them out.
 */

/** The emails the reset deletes: every one with a campaign or a sequence step. */
export const RESET_DISPATCH_WHERE: Prisma.EmailDispatchWhereInput = {
  OR: [{ campaignId: { not: null } }, { stepOrder: { not: null } }],
};

/** Sequence emails whose campaign is already gone, swept after the per-campaign batches. */
export const ORPHAN_SEQUENCE_DISPATCH_WHERE: Prisma.EmailDispatchWhereInput = {
  campaignId: null,
  stepOrder: { not: null },
};

/** The emails the reset keeps: mailbox tests and Unibox replies, which have no campaign and no step. */
export const KEPT_DISPATCH_WHERE: Prisma.EmailDispatchWhereInput = { campaignId: null, stepOrder: null };

/** Enrollments whose lastError may be an azure-dropped or clock-skew one; planLeadFlagChanges decides. */
export const FLAGGED_ENROLLMENT_WHERE: Prisma.CampaignEnrollmentWhereInput = {
  OR: [
    { lastError: { contains: 'AllRecipientsSuppressed', mode: 'insensitive' } },
    { lastError: { contains: 'time difference between the originating client', mode: 'insensitive' } },
  ],
};

/** Most ids one batch deletes, or one membership write adds. */
export const RESET_BATCH_SIZE = 5000;

export type AzureDroppedChoice = 'suppress' | 'keep';
export type ClockSkewChoice = 'reset' | 'keep';

export type ResetOptions = {
  apply: boolean;
  /** Where the export folder is made; must be outside the repository. */
  out: string;
  /** The dry run's count of emails to delete; --apply refuses unless it matches. */
  expectDispatches: number | null;
  /** Null when not given, which only a dry run allows. */
  azureDropped: AzureDroppedChoice | null;
  clockSkew: ClockSkewChoice | null;
  saveProgressGroups: boolean | null;
};

const VALUE_FLAGS = ['--out', '--expect-dispatches', '--azure-dropped', '--clock-skew', '--save-progress-groups'];

/**
 * The options in `argv` (the script's arguments), or why they are refused: an
 * unknown or repeated argument, a value out of range, a missing --out, or
 * --apply without every decision flag and --expect-dispatches.
 */
export function parseResetArgs(argv: string[]): { ok: true; options: ResetOptions } | { ok: false; error: string } {
  let apply = false;
  const values = new Map<string, string>();
  for (const arg of argv) {
    if (arg === '--apply') {
      apply = true;
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (!VALUE_FLAGS.includes(name) || (eq === -1 && name !== '--save-progress-groups')) {
      return { ok: false, error: `Unknown argument: ${arg}` };
    }
    if (values.has(name)) return { ok: false, error: `${name} is given more than once.` };
    // A bare --save-progress-groups says yes
    values.set(name, eq === -1 ? 'yes' : arg.slice(eq + 1));
  }

  const out = values.get('--out') ?? '';
  if (!out.trim()) return { ok: false, error: 'Pass --out=<folder outside the repository> for the export.' };

  const expect = values.get('--expect-dispatches');
  if (expect !== undefined && !/^\d+$/.test(expect)) {
    return { ok: false, error: '--expect-dispatches must be the whole number of emails the dry run would delete.' };
  }
  const azure = values.get('--azure-dropped');
  if (azure !== undefined && azure !== 'suppress' && azure !== 'keep') {
    return { ok: false, error: '--azure-dropped must be suppress or keep.' };
  }
  const clock = values.get('--clock-skew');
  if (clock !== undefined && clock !== 'reset' && clock !== 'keep') {
    return { ok: false, error: '--clock-skew must be reset or keep.' };
  }
  const groups = values.get('--save-progress-groups');
  if (groups !== undefined && groups !== 'yes' && groups !== 'no') {
    return { ok: false, error: '--save-progress-groups must be yes or no.' };
  }

  if (apply) {
    const missing = [
      expect === undefined && '--expect-dispatches=<count from the dry run>',
      azure === undefined && '--azure-dropped=suppress|keep',
      clock === undefined && '--clock-skew=reset|keep',
      groups === undefined && '--save-progress-groups=yes|no',
    ].filter((flag): flag is string => Boolean(flag));
    if (missing.length > 0) return { ok: false, error: `--apply needs ${missing.join(', ')}.` };
  }

  return {
    ok: true,
    options: {
      apply,
      out,
      expectDispatches: expect === undefined ? null : Number(expect),
      azureDropped: (azure as AzureDroppedChoice | undefined) ?? null,
      clockSkew: (clock as ClockSkewChoice | undefined) ?? null,
      saveProgressGroups: groups === undefined ? null : groups === 'yes',
    },
  };
}

/** Whether `child` is `parent` or inside it. */
export function isInsideDir(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** Why the export may not go under `outDir`, or null when it may: it holds email addresses, so never inside a repository. */
export function outDirRefusal(outDir: string, repoRoots: string[]): string | null {
  const root = repoRoots.find((dir) => isInsideDir(outDir, dir));
  return root === undefined
    ? null
    : `--out must be outside the repository (${root}), since the export holds email addresses.`;
}

/** The host of a Postgres DATABASE_URL (its ?host= when set, as Prisma reads it), or null when there is none. Never the URL. */
export function databaseHost(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get('host') || decodeURIComponent(parsed.hostname) || null;
  } catch {
    return null;
  }
}

/** ACS refused the send because the address is on its own suppression list (EmailDroppedAllRecipientsSuppressed). */
export function isAzureDroppedError(lastError: string | null | undefined): boolean {
  return typeof lastError === 'string' && /AllRecipientsSuppressed/i.test(lastError);
}

/** Azure refused the request for the host's clock (lib/sendEngine treats it as systemic now). */
export function isClockSkewError(lastError: string | null | undefined): boolean {
  return typeof lastError === 'string' && lastError.toLowerCase().includes('time difference between the originating client');
}

/** An enrollment with its lead, as the flag plan reads it. */
export type FlagEnrollment = {
  leadId: string;
  campaignName: string;
  status: string;
  lastError: string | null;
  lead: { email: string; status: LeadStatus; validationStatus: LeadValidationStatus };
};

export type LeadFlagState = {
  status: LeadStatus;
  validationStatus: LeadValidationStatus;
  /** The address's suppression-list reason, or null when it is not on the list. */
  suppression: SuppressionReason | null;
};

export type LeadFlagChange = {
  kind: 'azure-dropped' | 'clock-skew';
  leadId: string;
  email: string;
  /** The campaigns and statuses of the enrollments whose lastError matched. */
  campaigns: string[];
  enrollmentStatuses: string[];
  lastError: string;
  current: LeadFlagState;
  planned: LeadFlagState;
  /** Whether applying it changes anything; false once a run before has applied it. */
  changes: boolean;
};

function sameState(a: LeadFlagState, b: LeadFlagState): boolean {
  return a.status === b.status && a.validationStatus === b.validationStatus && a.suppression === b.suppression;
}

/**
 * The lead flag changes the enrollments call for (see the module comment), one
 * per lead, azure-dropped first, each ordered by address. `suppression` holds
 * the suppression-list reasons of the leads' addresses, keyed by normalised
 * address. A clock-skew lead is listed only while it is still Risky.
 */
export function planLeadFlagChanges(
  enrollments: FlagEnrollment[],
  suppression: Map<string, SuppressionReason>,
): LeadFlagChange[] {
  const byLead = (match: (lastError: string | null) => boolean) => {
    const leads = new Map<string, FlagEnrollment[]>();
    for (const enrollment of enrollments) {
      if (!match(enrollment.lastError)) continue;
      leads.set(enrollment.leadId, [...(leads.get(enrollment.leadId) ?? []), enrollment]);
    }
    return leads;
  };
  const describe = (kind: LeadFlagChange['kind'], matched: FlagEnrollment[], plan: (current: LeadFlagState, email: string) => LeadFlagState): LeadFlagChange => {
    const { lead } = matched[0];
    const email = normalizeEmail(lead.email);
    const current: LeadFlagState = { status: lead.status, validationStatus: lead.validationStatus, suppression: suppression.get(email) ?? null };
    const planned = plan(current, email);
    return {
      kind,
      leadId: matched[0].leadId,
      email: lead.email,
      campaigns: matched.map((e) => e.campaignName),
      enrollmentStatuses: matched.map((e) => e.status),
      lastError: matched[0].lastError ?? '',
      current,
      planned,
      changes: !sameState(current, planned),
    };
  };
  const byEmail = (a: LeadFlagChange, b: LeadFlagChange) => a.email.localeCompare(b.email);

  const dropped = byLead(isAzureDroppedError);
  const azure = [...dropped.values()].map((matched) => describe('azure-dropped', matched, (current, email) => ({
    status: current.status === 'Unsubscribed' ? 'Unsubscribed' : 'Bounced',
    validationStatus: 'Invalid',
    // An address already on the list keeps its first reason; a blank one cannot be listed
    suppression: current.suppression ?? (email ? 'HardBounce' : null),
  }))).sort(byEmail);

  const clock = [...byLead(isClockSkewError)]
    .filter(([leadId, matched]) => !dropped.has(leadId) && matched[0].lead.validationStatus === 'Risky')
    .map(([, matched]) => describe('clock-skew', matched, (current) => ({ ...current, validationStatus: 'Unverified' })))
    .sort(byEmail);

  return [...azure, ...clock];
}

/**
 * Applies the planned lead flag changes the options turn on, selecting each
 * lead by its current state so a second run changes nothing: azure-dropped
 * addresses go on the suppression list as HardBounce (source 'backfill') and
 * their leads become Invalid, and Bounced unless Unsubscribed; clock-skew
 * leads still Risky become Unverified. Returns how many rows each write changed.
 */
export async function applyLeadFlagChanges(
  client: Pick<Prisma.TransactionClient, 'lead' | 'suppressedEmail'>,
  changes: LeadFlagChange[],
  options: { azureDropped: AzureDroppedChoice; clockSkew: ClockSkewChoice },
): Promise<{ suppressed: number; bounced: number; invalidOnly: number; unverified: number }> {
  const result = { suppressed: 0, bounced: 0, invalidOnly: 0, unverified: 0 };
  const azure = changes.filter((change) => change.kind === 'azure-dropped');
  if (options.azureDropped === 'suppress' && azure.length > 0) {
    const ids = azure.map((change) => change.leadId);
    result.suppressed = await suppressEmails(client, azure.map((change) => ({ email: change.email, reason: 'HardBounce' as const })), 'backfill');
    result.bounced = (await client.lead.updateMany({
      where: { id: { in: ids }, status: { not: 'Unsubscribed' }, OR: [{ status: { not: 'Bounced' } }, { validationStatus: { not: 'Invalid' } }] },
      data: { status: 'Bounced', validationStatus: 'Invalid' },
    })).count;
    result.invalidOnly = (await client.lead.updateMany({
      where: { id: { in: ids }, status: 'Unsubscribed', validationStatus: { not: 'Invalid' } },
      data: { validationStatus: 'Invalid' },
    })).count;
  }
  const clock = changes.filter((change) => change.kind === 'clock-skew');
  if (options.clockSkew === 'reset' && clock.length > 0) {
    result.unverified = (await client.lead.updateMany({
      where: { id: { in: clock.map((change) => change.leadId) }, validationStatus: 'Risky' },
      data: { validationStatus: 'Unverified' },
    })).count;
  }
  return result;
}

/** The changes applyLeadFlagChanges makes with `options`: those its flag turns on that change anything. */
export function appliedLeadFlagChanges(
  changes: LeadFlagChange[],
  options: { azureDropped: AzureDroppedChoice | null; clockSkew: ClockSkewChoice | null },
): LeadFlagChange[] {
  return changes.filter((change) => change.changes && (change.kind === 'azure-dropped'
    ? options.azureDropped === 'suppress'
    : options.clockSkew === 'reset'));
}

/** One row of an emailDispatch.groupBy by campaignId, leadId and status, with _count._all and _max of stepOrder and sentAt. */
export type DispatchGroupRow = {
  campaignId: string | null;
  leadId: string | null;
  status: string;
  _count: { _all: number };
  _max: { stepOrder: number | null; sentAt: Date | null };
};

/** What a campaign sent one lead: Sent and Failed emails, and the highest step and latest time of the Sent ones. */
export type LeadSends = { sent: number; failed: number; highestStepSent: number | null; lastSentAt: Date | null };

/**
 * The emails each campaign sent each lead, keyed by campaign id then lead id.
 * Sending and Unknown rows count as neither sent nor failed; rows with no
 * campaign or no lead are left out.
 */
export function summarizeLeadSends(rows: DispatchGroupRow[]): Map<string, Map<string, LeadSends>> {
  const out = new Map<string, Map<string, LeadSends>>();
  for (const row of rows) {
    if (!row.campaignId || !row.leadId) continue;
    const leads = out.get(row.campaignId) ?? new Map<string, LeadSends>();
    out.set(row.campaignId, leads);
    const sends = leads.get(row.leadId) ?? { sent: 0, failed: 0, highestStepSent: null, lastSentAt: null };
    leads.set(row.leadId, sends);
    if (row.status === 'Sent') {
      sends.sent += row._count._all;
      if (row._max.stepOrder != null && (sends.highestStepSent == null || row._max.stepOrder > sends.highestStepSent)) {
        sends.highestStepSent = row._max.stepOrder;
      }
      if (row._max.sentAt && (!sends.lastSentAt || row._max.sentAt > sends.lastSentAt)) sends.lastSentAt = row._max.sentAt;
    } else if (row.status === 'Failed') {
      sends.failed += row._count._all;
    }
  }
  return out;
}

/** The names of a campaign's progress groups. */
export function progressGroupNames(campaignName: string): { finished: string; contacted: string } {
  return { finished: `${campaignName} - Finished`, contacted: `${campaignName} - Contacted, not finished` };
}

/**
 * A campaign's leads by progress: finished (enrollment Completed, or sent the
 * campaign's last step) and contacted (sent at least one email, not finished).
 * `lastStep` is the highest stepOrder of its steps, null when it has none.
 * Each list is sorted.
 */
export function campaignProgress(
  lastStep: number | null,
  enrollments: { leadId: string; status: string }[],
  sends: Map<string, LeadSends>,
): { finished: string[]; contacted: string[] } {
  const completed = new Set(enrollments.filter((e) => e.status === 'Completed').map((e) => e.leadId));
  const leadIds = new Set([...enrollments.map((e) => e.leadId), ...sends.keys()]);
  const finished: string[] = [];
  const contacted: string[] = [];
  for (const leadId of leadIds) {
    const lead = sends.get(leadId);
    if (completed.has(leadId) || (lastStep != null && lead?.highestStepSent === lastStep)) finished.push(leadId);
    else if (lead && lead.sent > 0) contacted.push(leadId);
  }
  return { finished: finished.sort(), contacted: contacted.sort() };
}

export type ProgressGroupPlan = { campaignId: string; campaignName: string; name: string; description: string; leadIds: string[] };

/**
 * The progress groups to save for each campaign: its finished and its
 * contacted-not-finished leads, leaving out a group that would be empty.
 * `day` (YYYY-MM-DD) dates the description.
 */
export function planProgressGroups(
  campaigns: { id: string; name: string; lastStep: number | null }[],
  enrollments: { campaignId: string; leadId: string; status: string }[],
  sends: Map<string, Map<string, LeadSends>>,
  day: string,
): ProgressGroupPlan[] {
  const plans: ProgressGroupPlan[] = [];
  for (const campaign of campaigns) {
    const progress = campaignProgress(
      campaign.lastStep,
      enrollments.filter((e) => e.campaignId === campaign.id),
      sends.get(campaign.id) ?? new Map(),
    );
    const names = progressGroupNames(campaign.name);
    const groups = [
      { name: names.finished, leadIds: progress.finished, who: `Leads that completed "${campaign.name}" or were sent its last step` },
      { name: names.contacted, leadIds: progress.contacted, who: `Leads "${campaign.name}" emailed at least once that had not finished it` },
    ];
    for (const group of groups) {
      if (group.leadIds.length === 0) continue;
      plans.push({
        campaignId: campaign.id,
        campaignName: campaign.name,
        name: group.name,
        description: `${group.who}, saved when its history was reset on ${day}.`,
        leadIds: group.leadIds,
      });
    }
  }
  return plans;
}

/**
 * Creates each planned group, or reuses the group of that name (lead groups
 * have no owner and unique names), and adds its leads, skipping those already
 * in it. Returns, per group, whether it was created and how many leads were added.
 * No campaign targets these groups, so adding leads enrolls no one.
 */
export async function saveProgressGroups(
  client: Pick<Prisma.TransactionClient, 'leadGroup' | 'leadGroupMembership'>,
  plans: ProgressGroupPlan[],
): Promise<{ name: string; created: boolean; added: number }[]> {
  const results: { name: string; created: boolean; added: number }[] = [];
  for (const plan of plans) {
    const existing = await client.leadGroup.findUnique({ where: { name: plan.name }, select: { id: true } });
    const group = existing ?? await client.leadGroup.create({ data: { name: plan.name, description: plan.description }, select: { id: true } });
    let added = 0;
    for (let i = 0; i < plan.leadIds.length; i += RESET_BATCH_SIZE) {
      const { count } = await client.leadGroupMembership.createMany({
        data: plan.leadIds.slice(i, i + RESET_BATCH_SIZE).map((leadId) => ({ leadId, groupId: group.id })),
        skipDuplicates: true,
      });
      added += count;
    }
    results.push({ name: plan.name, created: !existing, added });
  }
  return results;
}

/** An enrollment as the export reads it. */
export type ExportEnrollment = {
  leadId: string;
  campaignId: string;
  status: string;
  currentSequenceStep: number;
  retryCount: number;
  lastError: string | null;
  lastBounceType: string | null;
  enrolledAt: Date;
  lead: { email: string };
};

/** enrollments.csv's columns. */
export const ENROLLMENT_EXPORT_COLUMNS = [
  { key: 'leadId', label: 'Lead Id' },
  { key: 'email', label: 'Email' },
  { key: 'campaignId', label: 'Campaign Id' },
  { key: 'campaign', label: 'Campaign' },
  { key: 'enrollmentStatus', label: 'Enrollment Status' },
  { key: 'currentStep', label: 'Current Step' },
  { key: 'retryCount', label: 'Retry Count' },
  { key: 'lastError', label: 'Last Error' },
  { key: 'lastBounceType', label: 'Bounce Type' },
  { key: 'enrolledAt', label: 'Enrolled At' },
  { key: 'sentEmails', label: 'Sent Emails' },
  { key: 'failedEmails', label: 'Failed Emails' },
  { key: 'highestStepSent', label: 'Highest Step Sent' },
  { key: 'lastSentAt', label: 'Last Sent At' },
];

/**
 * enrollments.csv's rows: one per enrollment with what its campaign sent the
 * lead, then one per lead a campaign emailed without an enrollment (enrollment
 * columns blank, email from `emails`), so the export keeps everyone who got
 * an email.
 */
export function enrollmentExportRows(
  enrollments: ExportEnrollment[],
  sends: Map<string, Map<string, LeadSends>>,
  campaignNames: Map<string, string>,
  emails: Map<string, string>,
): Record<string, unknown>[] {
  const sendColumns = (s: LeadSends | undefined) => ({
    sentEmails: s?.sent ?? 0,
    failedEmails: s?.failed ?? 0,
    highestStepSent: s?.highestStepSent ?? null,
    lastSentAt: s?.lastSentAt ?? null,
  });
  const enrolled = new Set<string>();
  const rows: Record<string, unknown>[] = enrollments.map((e) => {
    enrolled.add(`${e.campaignId}\n${e.leadId}`);
    return {
      leadId: e.leadId,
      email: e.lead.email,
      campaignId: e.campaignId,
      campaign: campaignNames.get(e.campaignId) ?? '',
      enrollmentStatus: e.status,
      currentStep: e.currentSequenceStep,
      retryCount: e.retryCount,
      lastError: e.lastError,
      lastBounceType: e.lastBounceType,
      enrolledAt: e.enrolledAt,
      ...sendColumns(sends.get(e.campaignId)?.get(e.leadId)),
    };
  });
  for (const [campaignId, leads] of sends) {
    for (const [leadId, s] of leads) {
      if (enrolled.has(`${campaignId}\n${leadId}`)) continue;
      rows.push({ leadId, email: emails.get(leadId) ?? '', campaignId, campaign: campaignNames.get(campaignId) ?? '', ...sendColumns(s) });
    }
  }
  return rows;
}

/** lead-flag-changes.csv's columns. */
export const LEAD_FLAG_EXPORT_COLUMNS = [
  { key: 'leadId', label: 'Lead Id' },
  { key: 'email', label: 'Email' },
  { key: 'change', label: 'Change' },
  { key: 'flag', label: 'Flag' },
  { key: 'campaigns', label: 'Campaigns' },
  { key: 'enrollmentStatuses', label: 'Enrollment Statuses' },
  { key: 'lastError', label: 'Last Error' },
  { key: 'currentStatus', label: 'Current Status' },
  { key: 'currentValidationStatus', label: 'Current Validation Status' },
  { key: 'currentSuppression', label: 'Current Suppression' },
  { key: 'plannedStatus', label: 'Planned Status' },
  { key: 'plannedValidationStatus', label: 'Planned Validation Status' },
  { key: 'plannedSuppression', label: 'Planned Suppression' },
  { key: 'changes', label: 'Changes Anything' },
];

/** lead-flag-changes.csv's rows; `Flag` says what the run was told to do with each kind. */
export function leadFlagExportRows(
  changes: LeadFlagChange[],
  options: { azureDropped: AzureDroppedChoice | null; clockSkew: ClockSkewChoice | null },
): Record<string, unknown>[] {
  return changes.map((change) => {
    const choice = change.kind === 'azure-dropped' ? options.azureDropped : options.clockSkew;
    return {
      leadId: change.leadId,
      email: change.email,
      change: change.kind,
      flag: choice === null ? 'not given' : `--${change.kind}=${choice}`,
      campaigns: change.campaigns.join('; '),
      enrollmentStatuses: change.enrollmentStatuses.join('; '),
      lastError: change.lastError,
      currentStatus: change.current.status,
      currentValidationStatus: change.current.validationStatus,
      currentSuppression: change.current.suppression ?? '',
      plannedStatus: change.planned.status,
      plannedValidationStatus: change.planned.validationStatus,
      plannedSuppression: change.planned.suppression ?? '',
      changes: change.changes ? 'yes' : 'no',
    };
  });
}

/** How many of `items` fall under each key, keys in order of first appearance. */
export function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) counts[key(item)] = (counts[key(item)] ?? 0) + 1;
  return counts;
}

/** A lead's status and validation status, the key of the lead breakdown. */
export function leadStateKey(state: { status: string; validationStatus: string }): string {
  return `${state.status}/${state.validationStatus}`;
}

/** Leads per status/validation status once `applied` (the changes the run made) moved each lead from its current to its planned state. */
export function expectedLeadBreakdown(before: Record<string, number>, applied: LeadFlagChange[]): Record<string, number> {
  const expected = { ...before };
  for (const change of applied) {
    const from = leadStateKey(change.current);
    const to = leadStateKey(change.planned);
    if (from === to) continue;
    expected[from] = (expected[from] ?? 0) - 1;
    expected[to] = (expected[to] ?? 0) + 1;
  }
  for (const key of Object.keys(expected)) if (expected[key] === 0) delete expected[key];
  return expected;
}

/** Each key whose count in `actual` differs from `expected`, described as "key: actual (expected n)". */
export function countMismatches(expected: Record<string, number>, actual: Record<string, number>): string[] {
  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  return [...keys]
    .filter((key) => (expected[key] ?? 0) !== (actual[key] ?? 0))
    .map((key) => `${key}: ${actual[key] ?? 0} (expected ${expected[key] ?? 0})`);
}

/** What the reset empties, as the script counts it: the emails it deletes and their events, and the campaigns with what cascades from them. */
export const RESET_TABLES = [
  'EmailDispatch (with a campaign or step)', 'EmailEvent (on those emails)', 'Campaign', 'CampaignStep',
  'CampaignEnrollment', 'CampaignSenderAccount',
] as const;

/** What the reset keeps, as the script counts it: never deleted from, and only added to by the lead flag step. */
export const KEPT_TABLES = [
  'Lead', 'SuppressedEmail', 'DeletedLead', 'LeadAlias', 'LeadGroup', 'LeadGroupMembership', 'Template',
  'SenderAccount', 'User', 'GlobalSettings', 'WorkerLease', 'InboundResponse',
  'EmailDispatch (no campaign or step)', 'EmailEvent (on kept emails)',
] as const;

export type TableCounts = Record<string, number>;

/**
 * What is wrong once a reset has run, or [] when nothing is: anything left in
 * the RESET_TABLES, and any kept table whose count is not its count `before`
 * plus what the lead flag step `added` to it.
 */
export function afterResetProblems(
  before: { kept: TableCounts },
  after: { reset: TableCounts; kept: TableCounts },
  added: TableCounts,
): string[] {
  const left = RESET_TABLES.filter((table) => (after.reset[table] ?? 0) !== 0)
    .map((table) => `${table}: ${after.reset[table]} left (expected 0)`);
  const expectedKept = Object.fromEntries(KEPT_TABLES.map((table) => [table, (before.kept[table] ?? 0) + (added[table] ?? 0)]));
  return [...left, ...countMismatches(expectedKept, after.kept)];
}

/** What the database holds before a reset is safe to apply. */
export type SafetyState = {
  campaigns: { name: string; status: string; pausedUntil: Date | null }[];
  /** Emails with a campaign or step still Sending. */
  sendingEmails: number;
  /** Enrollments with a send claim taken in the last 10 minutes (lib/sendEligibility SEND_CLAIM_TTL_MS). */
  recentClaims: number;
  /** Replies (InboundResponse) attributed to a campaign, which deleting it would detach. */
  campaignReplies: number;
};

export type SafetyCheck = { label: string; ok: boolean; detail: string };

/** The safety checks --apply needs to pass (and repeats while it deletes), each with what failed it. */
export function safetyChecks(state: SafetyState): SafetyCheck[] {
  const live = state.campaigns.filter((c) => c.status === 'Active' || c.pausedUntil !== null);
  return [
    {
      label: 'No campaign is Active or has an auto-resume time',
      ok: live.length === 0,
      detail: live.map((c) => `"${c.name}" ${c.status}${c.pausedUntil ? `, resumes ${c.pausedUntil.toISOString()}` : ''}`).join('; '),
    },
    { label: 'No campaign email is Sending', ok: state.sendingEmails === 0, detail: `${state.sendingEmails} Sending` },
    {
      label: 'No enrollment has a send claim from the last 10 minutes',
      ok: state.recentClaims === 0,
      detail: `${state.recentClaims} claimed`,
    },
    {
      label: 'No reply (InboundResponse) belongs to a campaign',
      ok: state.campaignReplies === 0,
      detail: `${state.campaignReplies} with a campaign`,
    },
  ];
}

/**
 * Why --apply must not run, or [] when it may: the export was not written,
 * a decision flag is missing, --expect-dispatches differs from the emails to
 * delete now, or a safety check failed. With no campaign and no campaign
 * email left there is nothing to delete, so --expect-dispatches is not checked
 * and a run after a finished reset does nothing.
 */
export function applyRefusals(input: {
  options: ResetOptions;
  exportWritten: boolean;
  resetDispatches: number;
  campaignCount: number;
  checks: SafetyCheck[];
}): string[] {
  const { options } = input;
  const refusals: string[] = [];
  if (!input.exportWritten) refusals.push('The export was not written in this run.');
  if (options.azureDropped === null || options.clockSkew === null || options.saveProgressGroups === null) {
    refusals.push('Pass --azure-dropped=suppress|keep, --clock-skew=reset|keep and --save-progress-groups=yes|no.');
  }
  const nothingLeft = input.resetDispatches === 0 && input.campaignCount === 0;
  if (!nothingLeft && options.expectDispatches !== input.resetDispatches) {
    refusals.push(
      `--expect-dispatches=${options.expectDispatches ?? '(missing)'} does not match the ${input.resetDispatches} campaign emails there are now. ` +
      'Run the dry run again and pass its count.'
    );
  }
  for (const check of input.checks) if (!check.ok) refusals.push(`${check.label}: ${check.detail}.`);
  return refusals;
}
