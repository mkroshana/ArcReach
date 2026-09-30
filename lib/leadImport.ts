/**
 * Row outcomes of a lead import, shared by POST /api/leads/bulk and the leads
 * page's CSV import, so the page reports exactly what the server did with each
 * row instead of one "added" count.
 */

/**
 * What an import did with one row:
 * - created: a new lead that may be emailed.
 * - suppressed: a new lead whose address is on the suppression list, created
 *   with its suppressed status and never emailed.
 * - existing: a lead with this address was already in the CRM. It is not
 *   changed, but joins the groups the import puts its leads in.
 * - duplicate: an earlier row of the same request has this address.
 * - invalid: the email is not one valid address (see parseLeadEmail).
 */
export type LeadImportOutcome = 'created' | 'suppressed' | 'existing' | 'duplicate' | 'invalid';

export const LEAD_IMPORT_OUTCOMES: readonly LeadImportOutcome[] = ['created', 'suppressed', 'existing', 'duplicate', 'invalid'];

/** How many rows had each outcome. */
export type LeadImportCounts = Record<LeadImportOutcome, number>;

/**
 * A lead's name, company or job title as POST /api/leads and POST
 * /api/leads/bulk store it: trimmed, and null when missing or blank, never a
 * stand-in value, so templates use their own fallback for it (as Add Lead and
 * the CSV import send it).
 */
export function leadTextField(value: unknown): string | null {
  return typeof value === 'string' ? value.trim() || null : null;
}

/** Most rows one POST /api/leads/bulk request takes. The leads page sends larger files in batches of this size. */
export const LEAD_IMPORT_BATCH_SIZE = 1000;

/** Counts of zero for every outcome. */
export function emptyLeadImportCounts(): LeadImportCounts {
  return { created: 0, suppressed: 0, existing: 0, duplicate: 0, invalid: 0 };
}

/** How many of `outcomes` are each outcome. */
export function countLeadImport(outcomes: readonly LeadImportOutcome[]): LeadImportCounts {
  const counts = emptyLeadImportCounts();
  for (const outcome of outcomes) counts[outcome]++;
  return counts;
}

/** What a whole CSV import did: the server's counts over the batches it took, plus what never reached it. */
export type LeadImportTotals = LeadImportCounts & {
  /** Rows whose Email cell was blank, skipped on the page. */
  blank: number;
  /** Rows in batches whose request failed, none of which was imported. */
  failed: number;
};

/** `n` with `singular` or its plural. */
function rowCount(n: number, singular = 'row'): string {
  return `${n} ${n === 1 ? singular : `${singular}s`}`;
}

/**
 * What a CSV import did, for its toast. `failure` is the error of the first
 * batch that failed, if any did. `intoGroup` says the import put its leads in a
 * group, which leads already in the CRM join too. Every row is counted in
 * exactly one place.
 */
export function describeLeadImport(totals: LeadImportTotals, failure?: string, intoGroup = false): string {
  const added = totals.created + totals.suppressed;
  let text = added > 0 ? `Imported ${rowCount(added, 'new lead')}` : 'No new leads were imported';
  if (totals.suppressed > 0) {
    text += `, ${totals.suppressed} of them on the suppression list (unsubscribed, bounced or invalid) and never emailed`;
  }
  text += '.';
  if (intoGroup && totals.existing > 0) {
    text += ` ${rowCount(totals.existing, 'lead')} already in the CRM ${totals.existing === 1 ? 'is' : 'are'} now in the group.`;
  }
  const skipped = [
    totals.existing > 0 && !intoGroup ? `${totals.existing} already in the CRM` : '',
    totals.duplicate > 0 ? `${totals.duplicate} repeating an earlier row's address` : '',
    totals.invalid > 0 ? `${totals.invalid} with an email that is not one valid address` : '',
    totals.blank > 0 ? `${totals.blank} with no email` : '',
  ].filter(Boolean);
  if (skipped.length > 0) text += ` Skipped ${skipped.join(', ')}.`;
  if (totals.failed > 0) {
    text += ` ${rowCount(totals.failed)} could not be imported${failure ? ` (${failure})` : ''}. ` +
      'The file is still loaded, so Confirm & Import again to retry them.';
  }
  return text;
}
