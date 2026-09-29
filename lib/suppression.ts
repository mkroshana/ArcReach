import type { LeadStatus, LeadValidationStatus, Prisma, SuppressionReason } from '@prisma/client';
import { normalizeEmail } from './leadEmail';

/**
 * The suppression list (SuppressedEmail): addresses that are never enrolled or
 * emailed again. It is keyed by the normalised address and has no relation to
 * Lead, so deleting a lead leaves its entry in place, and a lead created again
 * for the address comes back suppressed. An unsubscribe, a hard bounce (send
 * engine or delivery webhook) and a failed verification (a malformed address,
 * or a domain that does not exist or has no MX records, never a failed DNS
 * lookup) add an address; the first reason recorded for it stands. Nothing in
 * the app removes one.
 */

type SuppressionClient = Pick<Prisma.TransactionClient, 'suppressedEmail'>;

/** What recorded an entry, kept in SuppressedEmail.source. */
export type SuppressionSource = 'unsubscribe-link' | 'delivery-webhook' | 'send-engine' | 'verification' | 'backfill';

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

/**
 * The lead fields that show an address's suppression: an opt-out (unsubscribe
 * or complaint) is status Unsubscribed, a hard bounce status Bounced and
 * validation Invalid, a failed verification validation Invalid. A lead created
 * for a suppressed address gets them, and a lead update may not swap them for
 * values it could be mailed with (see liftsSuppression).
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

/** Lead statuses and validation statuses the send engine never mails (see sendableLeadWhere). */
const UNSENDABLE_STATUSES: unknown[] = ['Bounced', 'Unsubscribed'];
const UNSENDABLE_VALIDATION_STATUSES: unknown[] = ['Invalid'];

/**
 * Whether `update` would replace a field that shows a lead's suppression (see
 * suppressedLeadFields) with a value the lead could be mailed with, so that it
 * would look sendable and never be sent.
 */
export function liftsSuppression(
  update: { status?: unknown; validationStatus?: unknown },
  reason: SuppressionReason,
): boolean {
  const shown = suppressedLeadFields(reason);
  return (shown.status !== undefined && update.status !== undefined && !UNSENDABLE_STATUSES.includes(update.status))
    || (shown.validationStatus !== undefined && update.validationStatus !== undefined
      && !UNSENDABLE_VALIDATION_STATUSES.includes(update.validationStatus));
}
