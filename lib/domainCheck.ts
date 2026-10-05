/**
 * The leads page's domain MX check (POST /api/leads/verify). It looks up the
 * MX records of each lead's email domain, or its A record when it has none
 * (the domain's own address takes its mail then, RFC 5321 5.1). It never
 * contacts a mail server, so a Valid lead's mailbox may still not exist.
 *
 * - Valid: the domain has MX records, or an A record in their place.
 * - Invalid: the domain does not exist (NXDOMAIN), its only MX record is a
 *   null MX (RFC 7505: it accepts no mail), or the address or domain is
 *   malformed. Only these are certain, so only they suppress the address.
 * - Risky: the lookup failed (a timeout, SERVFAIL, a refused query) or the
 *   domain has neither MX nor A records. The check picks Risky leads up again,
 *   so running it again retries them.
 *
 * No DNS module is imported here, so the leads page can share the batch size.
 */

/** Most leads one check request takes. The leads page sends larger selections in batches of this size, one after another, so each request stays well inside the front end's timeout. */
export const DOMAIN_CHECK_BATCH_SIZE = 100;

/** Domains one check request looks up at once. */
export const DOMAIN_CHECK_CONCURRENCY = 20;

/** The validation status a domain check gives a lead. */
export type DomainCheckStatus = 'Valid' | 'Risky' | 'Invalid';

/** How many leads a check set to each validation status. */
export type DomainCheckCounts = { valid: number; risky: number; invalid: number };

/** The lookups the check makes: a dns.promises.Resolver in the route. */
export type DomainResolver = {
  resolveMx(domain: string): Promise<{ exchange: string; priority: number }[]>;
  resolve4(domain: string): Promise<string[]>;
};

/** The domain does not exist: NXDOMAIN, which Node reports as ENOTFOUND. */
const NOT_FOUND_CODES = ['ENOTFOUND', 'NXDOMAIN'];
/** The domain exists but has no records of the type asked for. */
const NO_DATA_CODE = 'ENODATA';
/** The resolver refused the name as malformed, which no retry changes. */
const BAD_NAME_CODE = 'EBADNAME';

function errorCode(err: unknown): string {
  return typeof (err as { code?: unknown })?.code === 'string' ? (err as { code: string }).code : '';
}

/** A null MX (RFC 7505): the record a domain publishes to say it accepts no mail, its exchange the root name, which Node reports as ''. */
function isNullMx(record: { exchange: string }): boolean {
  return record.exchange === '' || record.exchange === '.';
}

/** The lowercased domain of `email`, or null when it is not one '@' between a non-empty local part and domain. */
export function emailDomain(email: string): string | null {
  const parts = email.trim().split('@');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return parts[1].toLowerCase();
}

/** Checks one domain. Never throws: a lookup that fails any other way is Risky. */
export async function checkDomainMx(resolver: DomainResolver, domain: string): Promise<DomainCheckStatus> {
  try {
    const records = await resolver.resolveMx(domain);
    if (records.some((record) => !isNullMx(record))) return 'Valid';
    // Only a null MX: the domain says it accepts no mail, so its A record takes none either
    if (records.length > 0) return 'Invalid';
  } catch (err) {
    const code = errorCode(err);
    if (NOT_FOUND_CODES.includes(code) || code === BAD_NAME_CODE) return 'Invalid';
    if (code !== NO_DATA_CODE) return 'Risky';
  }
  // No MX records, so the domain's own address would take its mail. The MX
  // answer said the domain exists, so no A lookup result makes it Invalid.
  try {
    return (await resolver.resolve4(domain)).length > 0 ? 'Valid' : 'Risky';
  } catch {
    return 'Risky';
  }
}

/** Checks each distinct domain of `domains` once, at most `concurrency` at a time, keyed by domain. */
export async function checkDomains(
  resolver: DomainResolver,
  domains: string[],
  concurrency = DOMAIN_CHECK_CONCURRENCY,
): Promise<Map<string, DomainCheckStatus>> {
  const pending = Array.from(new Set(domains));
  const results = new Map<string, DomainCheckStatus>();
  let next = 0;
  const worker = async () => {
    while (next < pending.length) {
      const domain = pending[next++];
      results.set(domain, await checkDomainMx(resolver, domain));
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker));
  return results;
}
