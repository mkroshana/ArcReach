import type { LeadStatus, LeadValidationStatus, Prisma, SuppressionReason } from '@prisma/client';
import { leadEmailIn, normalizeEmail } from './leadEmail';

/**
 * The suppression list (SuppressedEmail): addresses that are never enrolled or
 * emailed again. It is keyed by the normalised address and has no relation to
 * Lead, so deleting a lead leaves its entry in place, and a lead created again
 * for the address comes back suppressed. An unsubscribe, a hard bounce (send
 * engine or delivery webhook) and a failed domain MX check (a malformed
 * address or a domain that does not exist, never a failed DNS lookup; see
 * lib/domainCheck) add an address; the first reason recorded for it stands. No lead
 * edit lifts one: the lead status is CRM sentiment, and the leads page and
 * Unibox show a suppression from the list whatever the status says. Only an
 * admin removes an address, one at a time (DELETE /api/leads/suppression, see
 * unsuppressEmail).
 */

type SuppressionClient = Pick<Prisma.TransactionClient, 'suppressedEmail'>;

/** What recorded an entry, kept in SuppressedEmail.source. */
export type SuppressionSource = 'unsubscribe-link' | 'delivery-webhook' | 'send-engine' | 'verification' | 'backfill';

/** An address's suppression-list entry, as the lead and Unibox APIs return it on each lead (`suppression`). */
export type SuppressionEntry = { reason: SuppressionReason; source: string; createdAt: Date };

/**
 * The lead statuses a user may set: CRM sentiment. Bounced and Unsubscribed are
 * written only together with a suppression (suppressedLeadFields), so an
 * opt-out or bounce never lives in the status alone, and no status edit adds or
 * lifts a suppression.
 */
export const CRM_STATUSES: LeadStatus[] = ['Neutral', 'Interested', 'Not_Interested', 'Meeting_Booked', 'Out_of_Office'];

/** How the leads page and Unibox name each reason: the chip on the lead and why the address was added. */
export const SUPPRESSION_LABELS: Record<SuppressionReason, { chip: string; cause: string }> = {
  Unsubscribed: { chip: 'Unsubscribed', cause: 'the recipient unsubscribed' },
  Complaint: { chip: 'Unsubscribed', cause: 'the recipient reported an email as spam' },
  HardBounce: { chip: 'Bounced', cause: 'an email to it hard-bounced' },
  Invalid: { chip: 'Invalid', cause: 'it failed verification' },
};

/**
 * Most addresses one suppression-list read or write names: a large cohort
 * takes few round trips inside its enrollment transaction, and a write of
 * this many rows (4 values each) stays under Postgres's 32767 bind parameters.
 */
const SUPPRESSION_CHUNK = 5000;

/**
 * Adds addresses to the suppression list. An address already on it keeps its
 * first reason. Returns how many were added.
 */
export async function suppressEmails(
  client: SuppressionClient,
  entries: { email: string; reason: SuppressionReason }[],
  source: SuppressionSource,
): Promise<number> {
  const seen = new Set<string>();
  const data: Prisma.SuppressedEmailCreateManyInput[] = [];
  for (const entry of entries) {
    const email = normalizeEmail(entry.email);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    data.push({ email, reason: entry.reason, source });
  }
  let added = 0;
  for (let i = 0; i < data.length; i += SUPPRESSION_CHUNK) {
    const { count } = await client.suppressedEmail.createMany({
      data: data.slice(i, i + SUPPRESSION_CHUNK),
      skipDuplicates: true,
    });
    added += count;
  }
  return added;
}

/** Adds one address to the suppression list, keeping its first reason if it is already there. */
export async function suppressEmail(
  client: SuppressionClient,
  email: string,
  reason: SuppressionReason,
  source: SuppressionSource,
): Promise<void> {
  await suppressEmails(client, [{ email, reason }], source);
}

/** The suppression reasons of those of `emails` on the list, keyed by normalised address. */
export async function suppressionReasons(
  client: SuppressionClient,
  emails: string[],
): Promise<Map<string, SuppressionReason>> {
  const addresses = Array.from(new Set(emails.map(normalizeEmail).filter(Boolean)));
  const reasons = new Map<string, SuppressionReason>();
  for (let i = 0; i < addresses.length; i += SUPPRESSION_CHUNK) {
    const rows = await client.suppressedEmail.findMany({
      where: { email: { in: addresses.slice(i, i + SUPPRESSION_CHUNK) } },
      select: { email: true, reason: true },
    });
    for (const row of rows) reasons.set(row.email, row.reason);
  }
  return reasons;
}

/** The suppression-list entries of those of `emails` on the list, keyed by normalised address. */
export async function suppressionEntries(
  client: SuppressionClient,
  emails: string[],
): Promise<Map<string, SuppressionEntry>> {
  const addresses = Array.from(new Set(emails.map(normalizeEmail).filter(Boolean)));
  const entries = new Map<string, SuppressionEntry>();
  for (let i = 0; i < addresses.length; i += SUPPRESSION_CHUNK) {
    const rows = await client.suppressedEmail.findMany({
      where: { email: { in: addresses.slice(i, i + SUPPRESSION_CHUNK) } },
      select: { email: true, reason: true, source: true, createdAt: true },
    });
    for (const { email, ...entry } of rows) entries.set(email, entry);
  }
  return entries;
}

/** `leads`, each with `suppression`: its address's suppression-list entry, or null. */
export async function withSuppression<T extends { email: string }>(
  client: SuppressionClient,
  leads: T[],
): Promise<(T & { suppression: SuppressionEntry | null })[]> {
  const entries = await suppressionEntries(client, leads.map((lead) => lead.email));
  return leads.map((lead) => ({ ...lead, suppression: entries.get(normalizeEmail(lead.email)) ?? null }));
}

/**
 * The lead fields that show an address's suppression: an opt-out (unsubscribe
 * or complaint) is status Unsubscribed, a hard bounce status Bounced and
 * validation Invalid, a failed verification validation Invalid. A lead created
 * for a suppressed address gets them. A later status edit may replace the
 * status (it is CRM sentiment), but not the validation status (see
 * liftsSuppression); removing the address from the list gives the lead back
 * sendable values (see unsuppressEmail).
 */
export function suppressedLeadFields(
  reason: SuppressionReason,
): { status?: LeadStatus; validationStatus?: LeadValidationStatus } {
  switch (reason) {
    case 'HardBounce':
      return { status: 'Bounced', validationStatus: 'Invalid' };
    case 'Invalid':
      return { validationStatus: 'Invalid' };
    default:
      return { status: 'Unsubscribed' };
  }
}

/** Validation statuses the send engine never mails (see sendableLeadWhere). */
const UNSENDABLE_VALIDATION_STATUSES: unknown[] = ['Invalid'];

/**
 * Whether `update` would replace the validation status that shows a lead's
 * hard bounce or failed verification (see suppressedLeadFields) with one it
 * could be mailed with, so that it would look deliverable and never be sent.
 * The status is not checked: it is CRM sentiment, and a suppression shows from
 * the list whatever the status says.
 */
export function liftsSuppression(
  update: { validationStatus?: unknown },
  reason: SuppressionReason,
): boolean {
  return suppressedLeadFields(reason).validationStatus !== undefined
    && update.validationStatus !== undefined
    && !UNSENDABLE_VALIDATION_STATUSES.includes(update.validationStatus);
}

/**
 * Takes `email` off the suppression list and gives its lead back values it can
 * be mailed with in place of those suppressedLeadFields gave it: status
 * Unsubscribed or Bounced goes to Neutral, validation Invalid to Unverified,
 * so a bounced or invalid address is verified again. Enrollments are left as
 * they are. Returns the removed entry, or null when the address is not on the
 * list. Admin only, one address at a time (DELETE /api/leads/suppression).
 */
export async function unsuppressEmail(
  client: Pick<Prisma.TransactionClient, 'suppressedEmail' | 'lead'>,
  email: string,
): Promise<SuppressionEntry | null> {
  const address = normalizeEmail(email);
  const entry = (await suppressionEntries(client, [address])).get(address);
  if (!entry) return null;
  await client.suppressedEmail.deleteMany({ where: { email: address } });
  const shown = suppressedLeadFields(entry.reason);
  if (shown.status) {
    await client.lead.updateMany({ where: { ...leadEmailIn([address]), status: shown.status }, data: { status: 'Neutral' } });
  }
  if (shown.validationStatus) {
    await client.lead.updateMany({
      where: { ...leadEmailIn([address]), validationStatus: shown.validationStatus },
      data: { validationStatus: 'Unverified' },
    });
  }
  return entry;
}
