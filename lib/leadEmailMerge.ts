import type { LeadStatus, LeadValidationStatus, Prisma } from '@prisma/client';
import { leadEmailIn, normalizeEmail } from './leadEmail';
import { SEND_CLAIM_TTL_MS } from './sendEligibility';

/**
 * Rules scripts/normalize-lead-emails.ts uses to bring stored lead emails in
 * line with normalizeEmail. Leads whose emails differ only in case or
 * surrounding whitespace are one person: they are merged into one kept lead
 * that carries the most restrictive status and validation of the group and
 * every enrollment, dispatch, reply and group membership, and the others are
 * deleted, leaving their ids behind as LeadAlias rows for unsubscribe links.
 */

/** Lead statuses from least to most restrictive. Bounced and Unsubscribed stop all
 *  sending (an unsubscribe is the person's own opt-out, so it ranks highest),
 *  Not_Interested is an explicit no, and the rest rank by how far the person engaged. */
export const LEAD_STATUS_ORDER: readonly LeadStatus[] = [
  'Neutral',
  'Out_of_Office',
  'Interested',
  'Meeting_Booked',
  'Not_Interested',
  'Bounced',
  'Unsubscribed',
];

/** Validation statuses from least to most restrictive; Invalid is never sent to. */
export const VALIDATION_STATUS_ORDER: readonly LeadValidationStatus[] = ['Valid', 'Unverified', 'Risky', 'Invalid'];

/** The value of `values` that comes last in `order`. */
export function mostRestrictive<T>(order: readonly T[], values: T[]): T {
  return values.reduce((a, b) => (order.indexOf(b) > order.indexOf(a) ? b : a));
}

export interface LeadEmailRow {
  id: string;
  email: string;
  name: string | null;
  company: string | null;
  jobTitle: string | null;
  status: LeadStatus;
  validationStatus: LeadValidationStatus;
  isArchived: boolean;
  customVariables: Prisma.JsonValue | null;
  /** Enrollments, dispatches and replies on the row. */
  history: number;
}

export interface LeadEmailData {
  email: string;
  status: LeadStatus;
  validationStatus: LeadValidationStatus;
  isArchived: boolean;
  name: string | null;
  company: string | null;
  jobTitle: string | null;
  customVariables?: Prisma.InputJsonValue;
}

export interface LeadEmailPlan {
  /** The normalised address the kept lead ends up with. */
  email: string;
  keep: LeadEmailRow;
  /** Rows merged into `keep` and then deleted; empty when `keep` only needs its email normalised. */
  duplicates: LeadEmailRow[];
  /** Columns written to the kept lead once its duplicates are gone. */
  data: LeadEmailData;
}

/**
 * Order of preference for the lead kept from a group: the row already stored
 * under the normalised address, then the one with the most history, then the
 * lowest id so the choice is stable between a dry run and --apply.
 */
function keepOrder(email: string) {
  return (a: LeadEmailRow, b: LeadEmailRow) =>
    Number(b.email === email) - Number(a.email === email) ||
    b.history - a.history ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * The kept lead's columns after a merge: the normalised email, the most
 * restrictive status and validation in the group, archived only when every
 * row was (an archived variant is usually the copy someone set aside), and
 * name, company, job title and custom variables from the kept row, filled
 * from a duplicate where the kept row has none.
 */
export function mergedLeadData(email: string, keep: LeadEmailRow, duplicates: LeadEmailRow[]): LeadEmailData {
  const all = [keep, ...duplicates];
  const firstSet = (pick: (row: LeadEmailRow) => string | null) => all.map(pick).find((v) => !!v) ?? null;
  const data: LeadEmailData = {
    email,
    status: mostRestrictive(LEAD_STATUS_ORDER, all.map((r) => r.status)),
    validationStatus: mostRestrictive(VALIDATION_STATUS_ORDER, all.map((r) => r.validationStatus)),
    isArchived: all.every((r) => r.isArchived),
    name: firstSet((r) => r.name),
    company: firstSet((r) => r.company),
    jobTitle: firstSet((r) => r.jobTitle),
  };
  if (keep.customVariables == null) {
    const vars = duplicates.find((r) => r.customVariables != null)?.customVariables;
    if (vars != null) data.customVariables = vars as Prisma.InputJsonValue;
  }
  return data;
}

/**
 * Groups leads by normalised email and plans one change per group that needs
 * one: a merge when several rows share an address, or just a normalised email
 * for a lone row stored with capitals or spaces. Rows whose email is blank
 * once trimmed are returned apart and left alone.
 */
export function planLeadEmails(rows: LeadEmailRow[]): { plans: LeadEmailPlan[]; blank: LeadEmailRow[] } {
  const groups = new Map<string, LeadEmailRow[]>();
  const blank: LeadEmailRow[] = [];
  for (const row of rows) {
    const email = normalizeEmail(row.email);
    if (!email) {
      blank.push(row);
      continue;
    }
    const group = groups.get(email);
    if (group) group.push(row);
    else groups.set(email, [row]);
  }

  const plans: LeadEmailPlan[] = [];
  for (const [email, group] of groups) {
    if (group.length === 1 && group[0].email === email) continue;
    const [keep, ...duplicates] = [...group].sort(keepOrder(email));
    plans.push({ email, keep, duplicates, data: mergedLeadData(email, keep, duplicates) });
  }
  return { plans, blank };
}

export interface EnrollmentRow {
  id: string;
  leadId: string;
  campaignId: string;
  status: string;
  currentSequenceStep: number;
}

export interface EnrollmentResolution {
  /** Enrollments dropped because another in the same campaign survives. */
  deleteIds: string[];
  /** Duplicates' enrollments that move to the kept lead. */
  moveIds: string[];
  /** Survivors raised to the furthest step reached in their campaign. */
  stepUpdates: { id: string; currentSequenceStep: number }[];
}

/**
 * A lead has one enrollment per campaign, so where the kept lead and its
 * duplicates are enrolled in the same campaign one enrollment survives. A
 * stopped one (anything but Active: paused on a reply or unsubscribe, bounced,
 * failed, completed, removed) wins over an Active one, so a stop on either
 * address holds; otherwise the one further along wins, so no step goes out
 * twice. The survivor takes the furthest step any of them reached. A
 * duplicate's enrollment in a campaign the kept lead is not in just moves.
 */
export function resolveEnrollments(keepId: string, enrollments: EnrollmentRow[]): EnrollmentResolution {
  const byCampaign = new Map<string, EnrollmentRow[]>();
  for (const e of enrollments) {
    const list = byCampaign.get(e.campaignId);
    if (list) list.push(e);
    else byCampaign.set(e.campaignId, [e]);
  }

  const resolution: EnrollmentResolution = { deleteIds: [], moveIds: [], stepUpdates: [] };
  for (const list of byCampaign.values()) {
    const [winner, ...losers] = [...list].sort(
      (a, b) =>
        Number(b.status !== 'Active') - Number(a.status !== 'Active') ||
        b.currentSequenceStep - a.currentSequenceStep ||
        Number(b.leadId === keepId) - Number(a.leadId === keepId) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    resolution.deleteIds.push(...losers.map((e) => e.id));
    if (winner.leadId !== keepId) resolution.moveIds.push(winner.id);
    const furthest = Math.max(...list.map((e) => e.currentSequenceStep));
    if (winner.currentSequenceStep < furthest) {
      resolution.stepUpdates.push({ id: winner.id, currentSequenceStep: furthest });
    }
  }
  return resolution;
}

/** Whether a lead still has every column its plan was built from. */
function unchangedSincePlanned(planned: LeadEmailRow | undefined, row: Omit<LeadEmailRow, 'history'>): boolean {
  return (
    !!planned &&
    planned.email === row.email &&
    planned.status === row.status &&
    planned.validationStatus === row.validationStatus &&
    planned.isArchived === row.isArchived &&
    planned.name === row.name &&
    planned.company === row.company &&
    planned.jobTitle === row.jobTitle &&
    JSON.stringify(planned.customVariables) === JSON.stringify(row.customVariables)
  );
}

/**
 * Applies one plan inside a transaction: writes the kept lead's merged
 * columns, re-points the duplicates' enrollments (resolved per campaign),
 * dispatches, replies, group memberships and aliases to the kept lead, records
 * each duplicate's id as an alias and deletes the duplicates. Throws, rolling
 * the transaction back, when a lead in the group changed since it was planned
 * (another case variant, or a status, validation, archive or detail change such
 * as an unsubscribe or bounce), when a lead or enrollment changes while the
 * merge runs, or when a send holds a live claim on one of its enrollments.
 */
export async function mergeLeadGroup(
  tx: Prisma.TransactionClient,
  plan: LeadEmailPlan,
  now: Date = new Date(),
): Promise<EnrollmentResolution> {
  const keepId = plan.keep.id;
  const planned = new Map([plan.keep, ...plan.duplicates].map((r) => [r.id, r]));
  const ids = Array.from(planned.keys());
  const duplicateIds = ids.slice(1);
  const changed = () => new Error('its leads changed since they were read; re-run to plan it again');

  // Re-read everything the plan was built from: the old app stays live while
  // the script runs, so an unsubscribe, bounce webhook or Unibox status change
  // may have landed since, and plan.data must not overwrite it.
  const current = await tx.lead.findMany({
    where: { OR: [{ id: { in: ids } }, leadEmailIn([plan.email])] },
    select: {
      id: true, email: true, name: true, company: true, jobTitle: true,
      status: true, validationStatus: true, isArchived: true, customVariables: true,
    },
  });
  if (current.length !== planned.size || current.some((r) => !unchangedSincePlanned(planned.get(r.id), r))) {
    throw changed();
  }

  const enrollments = await tx.campaignEnrollment.findMany({
    where: { leadId: { in: ids } },
    select: { id: true, leadId: true, campaignId: true, status: true, currentSequenceStep: true, claimedAt: true },
  });
  const liveClaimSince = new Date(now.getTime() - SEND_CLAIM_TTL_MS);
  if (enrollments.some((e) => e.claimedAt && e.claimedAt >= liveClaimSince)) {
    throw new Error('a send is in progress for one of its enrollments; stop the send worker or re-run later');
  }

  // Every write below matches its rows only as they were just read, so a change
  // landing in between leaves a count short and the throw rolls the merge back.
  const expectCount = async (write: Promise<{ count: number }>, expected: number) => {
    if ((await write).count !== expected) throw changed();
  };
  const leadAsRead = (r: LeadEmailRow) => ({
    id: r.id, email: r.email, status: r.status, validationStatus: r.validationStatus, isArchived: r.isArchived,
  });
  const enrollmentsAsRead = (enrollmentIds: string[]) => ({
    OR: enrollments
      .filter((e) => enrollmentIds.includes(e.id))
      .map(({ id, status, currentSequenceStep, claimedAt }) => ({ id, status, currentSequenceStep, claimedAt })),
  });

  // Written first so the kept row is locked until commit: a later unsubscribe
  // or bounce on it waits and then lands on the merged row.
  await expectCount(tx.lead.updateMany({ where: leadAsRead(plan.keep), data: plan.data }), 1);

  const resolution = resolveEnrollments(keepId, enrollments);
  if (resolution.deleteIds.length > 0) {
    await expectCount(
      tx.campaignEnrollment.deleteMany({ where: enrollmentsAsRead(resolution.deleteIds) }),
      resolution.deleteIds.length,
    );
  }
  if (resolution.moveIds.length > 0) {
    await expectCount(
      tx.campaignEnrollment.updateMany({ where: enrollmentsAsRead(resolution.moveIds), data: { leadId: keepId } }),
      resolution.moveIds.length,
    );
  }
  for (const update of resolution.stepUpdates) {
    await expectCount(
      tx.campaignEnrollment.updateMany({
        where: enrollmentsAsRead([update.id]),
        data: { currentSequenceStep: update.currentSequenceStep },
      }),
      1,
    );
  }

  if (duplicateIds.length > 0) {
    await tx.emailDispatch.updateMany({ where: { leadId: { in: duplicateIds } }, data: { leadId: keepId } });
    await tx.inboundResponse.updateMany({ where: { leadId: { in: duplicateIds } }, data: { leadId: keepId } });

    const memberships = await tx.leadGroupMembership.findMany({
      where: { leadId: { in: duplicateIds } },
      select: { groupId: true },
    });
    if (memberships.length > 0) {
      await tx.leadGroupMembership.createMany({
        data: memberships.map((m) => ({ leadId: keepId, groupId: m.groupId })),
        skipDuplicates: true,
      });
    }

    // Unsubscribe links already sent to a duplicate carry its id.
    await tx.leadAlias.updateMany({ where: { leadId: { in: duplicateIds } }, data: { leadId: keepId } });
    await tx.leadAlias.createMany({ data: duplicateIds.map((id) => ({ id, leadId: keepId })) });

    await expectCount(tx.lead.deleteMany({ where: { OR: plan.duplicates.map(leadAsRead) } }), duplicateIds.length);
  }

  return resolution;
}
