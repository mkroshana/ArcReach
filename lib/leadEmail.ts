import type { Prisma } from '@prisma/client';

/**
 * Lead emails are stored trimmed and lowercased, so an address is one lead
 * however it was typed or imported. Every path that writes Lead.email goes
 * through normalizeEmail, and every lookup by address goes through leadEmailIn.
 * scripts/normalize-lead-emails.ts brings rows written before this in line.
 */

/** The stored form of an email address: trimmed and lowercased ('' for a non-string). */
export function normalizeEmail(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/** Longest address a mail path carries (RFC 5321 4.5.3.1: 256 octets less the angle brackets). */
const MAX_EMAIL_LENGTH = 254;
/** Longest local part (RFC 5321 4.5.3.1.1). */
const MAX_LOCAL_PART_LENGTH = 64;
/** A dot-atom local part (RFC 5322 3.4.1): letters, digits and the symbols it allows, with no leading, trailing or doubled dot. */
const LOCAL_PART = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
/** One domain label: 1-63 letters, digits and hyphens, not starting or ending with a hyphen. */
const DOMAIN_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The stored form of `value` (see normalizeEmail) when it is one plain email
 * address, else null. Add Lead, the CSV import and POST /api/leads/bulk all
 * check addresses with this, on the page and on the server. It accepts a
 * single dot-atom addr-spec on a domain name of two or more labels, so a
 * display name ('John <john@acme.com>'), a list ('a@x.com; b@x.com'), a quoted
 * local part, an IP address or domain literal, and non-ASCII addresses, which
 * need SMTPUTF8 on every server that relays them, are all refused.
 */
export function parseLeadEmail(value: unknown): string | null {
  const email = normalizeEmail(value);
  if (email.length > MAX_EMAIL_LENGTH) return null;
  const parts = email.split('@');
  if (parts.length !== 2) return null;
  const [local, domain] = parts;
  if (local.length > MAX_LOCAL_PART_LENGTH || !LOCAL_PART.test(local)) return null;
  const labels = domain.split('.');
  if (labels.length < 2 || !labels.every((label) => DOMAIN_LABEL.test(label))) return null;
  // A top-level domain is a name of two or more characters, never all digits as an IPv4 address's last part is
  const tld = labels[labels.length - 1];
  if (tld.length < 2 || /^[0-9]+$/.test(tld)) return null;
  return email;
}

/**
 * Lead filter matching any of `emails`, ignoring case. It is an insensitive
 * `in` on purpose: Prisma sends that to Postgres as lower(email) IN (lower(...)),
 * an exact match, while an insensitive `equals` becomes ILIKE, where the `_`
 * common in addresses would match any character.
 */
export function leadEmailIn(emails: string[]): Prisma.LeadWhereInput {
  const normalized = Array.from(new Set(emails.map(normalizeEmail).filter(Boolean)));
  return { email: { in: normalized, mode: 'insensitive' } };
}
