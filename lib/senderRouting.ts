/**
 * Which mailboxes of a campaign's sender pool send to which lead, by the
 * domain of the lead's email address.
 *
 * A mailbox with a list of recipient domains sends only to leads at those
 * domains. A mailbox with none sends to every lead whose domain no mailbox of
 * the pool lists. So with 'gmail.com' on one mailbox and no list on another,
 * Gmail leads go out from the first only and every other lead from the second
 * only. A lead never goes out from a mailbox that does not send to its domain:
 * while those that do are at their caps it waits for one of them.
 *
 * A mailbox's own list (SenderAccount.recipientDomains, the Accounts page)
 * holds in every campaign. Only a mailbox without one takes the list a
 * campaign gives it (CampaignSenderAccount.recipientDomains, the campaign's
 * Senders tab).
 *
 * A domain matches exactly: 'gmail.com' is not 'mail.gmail.com', and it does
 * not cover a company's own domain whose mail Google hosts.
 *
 * Has no Node-only imports so the pages can use it.
 */

import { normalizeEmail, parseLeadEmail } from './leadEmail';

/** Most domains one list holds. */
export const MAX_RECIPIENT_DOMAINS = 100;

/** A pool that would leave leads without a mailbox: saves refuse it. */
export const NO_OPEN_SENDER_ERROR =
  'Every sender mailbox of this campaign is limited to Recipient Domains, so a lead at any other domain would have no mailbox to send from. Leave Recipient Domains empty on at least one mailbox.';

/** The stored form of a typed recipient domain: trimmed, lowercased, without a leading '@'. */
export function normalizeRecipientDomain(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase().replace(/^@/, '') : '';
}

/** Whether `domain`, in its stored form, is a domain a lead's address can be at (parseLeadEmail). */
export function isRecipientDomain(domain: string): boolean {
  return parseLeadEmail(`a@${domain}`) !== null;
}

/**
 * Reads a list of recipient domains as a page or a request body gives it into
 * the list to store: each entry in its stored form, entries typed or pasted
 * together ('gmail.com, googlemail.com') split apart, duplicates dropped, in
 * the order given. An entry that is no domain name refuses the whole list.
 */
export function parseRecipientDomains(value: unknown): { domains: string[]; error: null } | { domains: null; error: string } {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    return { domains: null, error: 'Recipient Domains must be a list of domain names.' };
  }
  const domains: string[] = [];
  for (const entry of value as string[]) {
    for (const part of entry.split(/[\s,;]+/)) {
      const domain = normalizeRecipientDomain(part);
      if (!domain) continue;
      if (!isRecipientDomain(domain)) {
        return { domains: null, error: `"${part.trim()}" is not a domain name. Enter Recipient Domains such as gmail.com.` };
      }
      if (!domains.includes(domain)) domains.push(domain);
    }
  }
  if (domains.length > MAX_RECIPIENT_DOMAINS) {
    return { domains: null, error: `Recipient Domains takes at most ${MAX_RECIPIENT_DOMAINS} domains.` };
  }
  return { domains, error: null };
}

/** A stored list as read back: [] for a row loaded without the column. */
export function storedRecipientDomains(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/** The list a mailbox sends by in a campaign: its own when it has one, else the campaign's list for it. */
export function effectiveRecipientDomains(mailboxDomains: unknown, campaignDomains: unknown): string[] {
  const own = storedRecipientDomains(mailboxDomains);
  return own.length > 0 ? own : storedRecipientDomains(campaignDomains);
}

/** The domain of an email address in the form lists store it, or '' when it has none. */
export function recipientDomainOf(email: unknown): string {
  const address = normalizeEmail(email);
  const at = address.lastIndexOf('@');
  return at < 0 ? '' : address.slice(at + 1);
}

/** The list each mailbox of a pool sends by (effectiveRecipientDomains), by mailbox id; none or an empty one is no list. */
export type SenderRoutes = ReadonlyMap<string, readonly string[]>;

function routeOf(routes: SenderRoutes, senderId: string): readonly string[] {
  return routes.get(senderId) ?? [];
}

/**
 * The mailboxes of `pool` that send to `email`: those that list its domain,
 * or, when none does, those with no list. Empty when the domain is listed by
 * no mailbox and every mailbox has a list.
 */
export function sendersForRecipient<T extends { id: string }>(pool: T[], routes: SenderRoutes, email: unknown): T[] {
  const domain = recipientDomainOf(email);
  const listing = pool.filter((sender) => routeOf(routes, sender.id).includes(domain));
  if (listing.length > 0) return listing;
  return pool.filter((sender) => routeOf(routes, sender.id).length === 0);
}

/** NO_OPEN_SENDER_ERROR when every mailbox of `pool` has a list, so leads at other domains have none to send from; else null. */
export function unroutedPoolError(pool: Array<{ id: string }>, routes: SenderRoutes): string | null {
  if (pool.length === 0) return null;
  return pool.every((sender) => routeOf(routes, sender.id).length > 0) ? NO_OPEN_SENDER_ERROR : null;
}

function joined(items: string[]): string {
  return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * How a pool's mail is split, in one sentence for the Senders tab, or null
 * when no mailbox has a list (every lead may go out from any of them).
 * Mailboxes with the same list share its leads.
 */
export function routingSummary(pool: Array<{ id: string; emailAddress: string }>, routes: SenderRoutes): string | null {
  const groups = new Map<string, { domains: string[]; mailboxes: string[] }>();
  const open: string[] = [];
  for (const sender of pool) {
    const domains = [...routeOf(routes, sender.id)].sort();
    if (domains.length === 0) {
      open.push(sender.emailAddress);
      continue;
    }
    const key = domains.join(',');
    const group = groups.get(key) ?? { domains, mailboxes: [] };
    group.mailboxes.push(sender.emailAddress);
    groups.set(key, group);
  }
  if (groups.size === 0) return null;
  const parts = [...groups.values()].map((group) => `leads at ${joined(group.domains)} go out from ${joined(group.mailboxes)}`);
  parts.push(open.length > 0
    ? `leads at every other domain go out from ${joined(open)}`
    : 'leads at every other domain have no mailbox to send from');
  const sentence = parts.join('; ');
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}
