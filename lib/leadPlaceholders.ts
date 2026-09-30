/**
 * Stand-in values the leads page used to store for a lead with no name or
 * company: CSV import wrote the address's local part (the text before its
 * '@') as the name and 'Unknown' as the company, Add Lead wrote
 * 'Self Employed' as the company, and for a short while in June 2026 a click
 * on the import area added a typed address with its local part as the name and
 * 'External Node' as the company. personalizeEmail only falls back to 'there'
 * or 'your company' when the field is empty, so these went out in emails.
 * The app now stores null instead; scripts/clear-lead-placeholders.ts clears
 * the rows written before that, using planLeadPlaceholders.
 */

/** Companies the app stored for a lead with none, exactly as it wrote them. */
export const PLACEHOLDER_COMPANIES: readonly string[] = ['Unknown', 'Self Employed', 'External Node'];

export type LeadPlaceholderRow = {
  id: string;
  email: string;
  name: string | null;
  company: string | null;
};

export type LeadPlaceholderPlan = {
  /** Leads whose name is exactly their address's local part, as the import wrote it. */
  names: LeadPlaceholderRow[];
  /**
   * Leads whose name is their address's local part only once letter case or
   * spaces are ignored. The import wrote the local part exactly as it stored the
   * email, so its placeholders are in `names` while stored emails keep their
   * imported case. scripts/normalize-lead-emails.ts lowercases stored emails,
   * and scripts/clear-lead-placeholders.ts must run before it: afterwards
   * 'John' for john@acme.com may be a placeholder from John@Acme.com, or a
   * real first name.
   */
  caseVariantNames: LeadPlaceholderRow[];
  /** Leads whose company is one of PLACEHOLDER_COMPANIES. */
  companies: LeadPlaceholderRow[];
};

/** The text before the first '@' of `email`, as the import took it, or null when there is none. */
function localPart(email: string): string | null {
  const at = email.indexOf('@');
  return at > 0 ? email.slice(0, at) : null;
}

/** Sorts `rows` by which placeholder values they hold; a lead can be in both a name list and companies. */
export function planLeadPlaceholders(rows: LeadPlaceholderRow[]): LeadPlaceholderPlan {
  const plan: LeadPlaceholderPlan = { names: [], caseVariantNames: [], companies: [] };
  for (const row of rows) {
    const local = localPart(row.email);
    if (row.name !== null && local !== null) {
      const loose = local.trim().toLowerCase();
      if (row.name === local) {
        plan.names.push(row);
      } else if (loose !== '' && row.name.trim().toLowerCase() === loose) {
        plan.caseVariantNames.push(row);
      }
    }
    if (row.company !== null && PLACEHOLDER_COMPANIES.includes(row.company)) {
      plan.companies.push(row);
    }
  }
  return plan;
}
