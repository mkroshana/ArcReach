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
