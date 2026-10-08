/**
 * Which mailboxes of a campaign's sender pool send to which lead, by the
 * domain of the lead's email address and the mail provider that hosts it.
 *
 * A mailbox with a list of recipient domains sends only to the leads its list
 * covers. A mailbox with none sends to every lead no mailbox of the pool
 * covers. So with 'gmail.com' on one mailbox and no list on another, Gmail
 * leads go out from the first only and every other lead from the second only.
 * A lead never goes out from a mailbox that does not send to it: while those
 * that do are at their caps it waits for one of them.
 *
 * A list holds domains and mail providers (lib/mailProvider). A domain matches
 * exactly: 'gmail.com' is not 'mail.gmail.com'. A provider covers every domain
 * whose mail it hosts, a company's own domain included. A mailbox that lists a
 * lead's domain goes before one that lists its provider, so a domain can be
 * taken out of a provider's mailbox.
 *
 * A mailbox's own list (SenderAccount.recipientDomains, the Accounts page)
 * holds in every campaign. Only a mailbox without one takes the list a
 * campaign gives it (CampaignSenderAccount.recipientDomains, the campaign's
 * Senders tab).
 *
 * Has no Node-only imports so the pages can use it.
 */

import { normalizeEmail, parseLeadEmail } from './leadEmail';
import { MAIL_PROVIDERS, MAIL_PROVIDER_KEYS, type MailProvider, isMailProvider } from './mailProvider';

/** Most entries one list holds. */
export const MAX_RECIPIENT_DOMAINS = 100;

/** A pool that would leave leads without a mailbox: saves refuse it. */
export const NO_OPEN_SENDER_ERROR =
  'Every sender mailbox of this campaign is limited to Recipient Domains, so a lead at any other domain would have no mailbox to send from. Leave Recipient Domains empty on at least one mailbox.';

/**
 * How the send engine's reason (the enrollment's lastError) begins for a lead
 * it holds back for want of a mailbox, so a page can count those leads: no
 * mailbox of the pool sends to its domain, or every mailbox that does has
 * refused it (EmailDispatch.senderRefusedAt).
 */
export const NO_SENDER_FOR_LEAD_REASON = 'No sender mailbox of this campaign sends to';
export const REFUSED_BY_SENDERS_REASON = 'Refused by every sender mailbox allowed for this lead';

/** How a list names a mail provider: 'provider:google'. No domain name has a colon, so it is never taken for one. */
const PROVIDER_PREFIX = 'provider:';

/** The list entry that names `provider`. */
export function providerEntry(provider: MailProvider): string {
  return `${PROVIDER_PREFIX}${provider}`;
}

/** The provider a list entry names, or null for a domain. */
export function entryProvider(entry: string): MailProvider | null {
  if (!entry.startsWith(PROVIDER_PREFIX)) return null;
  const provider = entry.slice(PROVIDER_PREFIX.length);
  return isMailProvider(provider) ? provider : null;
}

/** The entries a list can name providers with, for the pages to offer. */
export const PROVIDER_ENTRIES = MAIL_PROVIDER_KEYS.map(providerEntry);

/** What a page shows for a list entry: a domain as it is, a provider by its name and what it covers. */
export function entryLabel(entry: string): string {
  const provider = entryProvider(entry);
  return provider ? `${MAIL_PROVIDERS[provider].label} (${MAIL_PROVIDERS[provider].covers})` : entry;
}

/** The stored form of a typed recipient domain: trimmed, lowercased, without a leading '@'. */
export function normalizeRecipientDomain(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase().replace(/^@/, '') : '';
}

/** Whether `domain`, in its stored form, is a domain a lead's address can be at (parseLeadEmail). */
export function isRecipientDomain(domain: string): boolean {
  return parseLeadEmail(`a@${domain}`) !== null;
}

/** The provider entry a typed or sent value names ('provider:google', or the provider's name alone), or null. */
function parseProviderEntry(value: string): string | null {
  const name = value.startsWith(PROVIDER_PREFIX) ? value.slice(PROVIDER_PREFIX.length) : value;
  return isMailProvider(name) ? providerEntry(name) : null;
}

/**
 * Reads a list of recipient domains as a page or a request body gives it into
 * the list to store: each entry in its stored form, entries typed or pasted
 * together ('gmail.com, googlemail.com') split apart, duplicates dropped, in
 * the order given. A mail provider is named by its entry ('provider:google')
 * or by its name alone ('Google'). An entry that is neither a provider nor a
 * domain name refuses the whole list.
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
      const stored = parseProviderEntry(domain) ?? (isRecipientDomain(domain) ? domain : null);
      if (stored === null) {
        return { domains: null, error: `"${part.trim()}" is not a domain name. Enter Recipient Domains such as gmail.com.` };
      }
      if (!domains.includes(stored)) domains.push(stored);
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

/** Whether any mailbox's list names a mail provider, so routing needs the provider of each lead's domain. */
export function routesUseProviders(routes: SenderRoutes): boolean {
  for (const route of routes.values()) {
    if (route.some((entry) => entryProvider(entry) !== null)) return true;
  }
  return false;
}

/**
 * Whether choosing the mailboxes for `email` takes the mail provider of its
 * domain: some mailbox of `pool` lists a provider, and none lists the domain
 * itself, which would decide it alone.
 */
export function needsMailProvider(pool: Array<{ id: string }>, routes: SenderRoutes, email: unknown): boolean {
  const domain = recipientDomainOf(email);
  let listsProvider = false;
  for (const sender of pool) {
    const route = routeOf(routes, sender.id);
    if (route.includes(domain)) return false;
    if (route.some((entry) => entryProvider(entry) !== null)) listsProvider = true;
  }
  return listsProvider;
}

/**
 * The mailboxes of `pool` that send to `email`: those that list its domain;
 * or, when none does, those that list `provider`, the mail provider that hosts
 * the domain (null when none of lib/mailProvider's does); or, when none does
 * either, those with no list. Empty when no mailbox covers the lead and every
 * mailbox has a list.
 */
export function sendersForRecipient<T extends { id: string }>(
  pool: T[],
  routes: SenderRoutes,
  email: unknown,
  provider: MailProvider | null = null,
): T[] {
  const domain = recipientDomainOf(email);
  const listing = pool.filter((sender) => routeOf(routes, sender.id).includes(domain));
  if (listing.length > 0) return listing;
  if (provider) {
    const hosting = pool.filter((sender) => routeOf(routes, sender.id).includes(providerEntry(provider)));
    if (hosting.length > 0) return hosting;
  }
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

/** A list's entries as a sentence names them: its domains in order, then its providers. */
function entriesInWords(route: readonly string[]): string[] {
  const domains = route.filter((entry) => entryProvider(entry) === null).sort();
  const providers = MAIL_PROVIDER_KEYS.filter((provider) => route.includes(providerEntry(provider)));
  return [...domains, ...providers.map((provider) => `any ${MAIL_PROVIDERS[provider].label}-hosted address`)];
}

/**
 * How a pool's mail is split, in one sentence for the Senders tab, or null
 * when no mailbox has a list (every lead may go out from any of them).
 * Mailboxes with the same list share its leads.
 */
export function routingSummary(pool: Array<{ id: string; emailAddress: string }>, routes: SenderRoutes): string | null {
  const groups = new Map<string, { entries: string[]; mailboxes: string[] }>();
  const open: string[] = [];
  for (const sender of pool) {
    const entries = entriesInWords(routeOf(routes, sender.id));
    if (entries.length === 0) {
      open.push(sender.emailAddress);
      continue;
    }
    const key = entries.join(',');
    const group = groups.get(key) ?? { entries, mailboxes: [] };
    group.mailboxes.push(sender.emailAddress);
    groups.set(key, group);
  }
  if (groups.size === 0) return null;
  const parts = [...groups.values()].map((group) => `leads at ${joined(group.entries)} go out from ${joined(group.mailboxes)}`);
  parts.push(open.length > 0
    ? `leads at every other domain go out from ${joined(open)}`
    : 'leads at every other domain have no mailbox to send from');
  const sentence = parts.join('; ');
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}
