/**
 * Finds the mail provider (lib/mailProvider) of recipient domains for the send
 * engine, which routes by it when a mailbox's Recipient Domains name one
 * (lib/senderRouting). A domain's MX records are looked up once and the answer
 * kept in MailDomain, then looked up again once it is MAIL_PROVIDER_TTL_MS
 * old, since a company can move its mail to another provider.
 */

import { promises as dnsPromises } from 'dns';
import { prisma } from './db';
import { type MailProvider, isMailProvider, mailProviderOfMx } from './mailProvider';

/** How long a stored answer stands before its domain is looked up again. */
export const MAIL_PROVIDER_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Most domains one call looks up, so a send cycle with many new domains is not held up; the others are left for a later call. */
export const MAIL_PROVIDER_LOOKUPS_PER_CALL = 40;

/** Domains looked up at once. */
const LOOKUP_CONCURRENCY = 20;

/** The lookup a provider is told from: a dns.promises.Resolver's resolveMx. */
export type MxResolver = {
  resolveMx(domain: string): Promise<{ exchange: string; priority: number }[]>;
};

let systemResolver: MxResolver | null = null;

/**
 * The resolver the engine's lookups use: 3 seconds for the first try and one
 * retry per name server, as the leads page's domain MX check has
 * (app/api/leads/verify), and the DNS servers DOMAIN_CHECK_DNS_SERVERS names
 * for it, for a machine where Node cannot find the system's own. Servers that
 * are not IP addresses are left out here; the MX check reports them.
 */
function defaultResolver(): MxResolver {
  if (!systemResolver) {
    const resolver = new dnsPromises.Resolver({ timeout: 3000, tries: 2 });
    const servers = (process.env.DOMAIN_CHECK_DNS_SERVERS ?? '').split(',').map((server) => server.trim()).filter(Boolean);
    if (servers.length > 0) {
      try {
        resolver.setServers(servers);
      } catch {
        console.warn('[MailProvider] DOMAIN_CHECK_DNS_SERVERS must be DNS server IP addresses separated by commas; using the system DNS servers.');
      }
    }
    systemResolver = resolver;
  }
  return systemResolver;
}

/** Answers that say the domain has no mail servers to tell a provider from: it does not exist, has no MX records or is no name. */
const NO_MX_CODES = ['ENOTFOUND', 'NXDOMAIN', 'ENODATA', 'EBADNAME'];

/**
 * The provider that hosts `domain`, null when its MX records name none
 * lib/mailProvider knows, 'no-mx' when it has no MX records to tell one from
 * (or does not exist), or 'failed' when the lookup gave no answer (a timeout,
 * SERVFAIL, a refused query). Never throws.
 */
export async function lookUpMailProvider(resolver: MxResolver, domain: string): Promise<MailProvider | null | 'no-mx' | 'failed'> {
  try {
    return mailProviderOfMx(await resolver.resolveMx(domain));
  } catch (err) {
    const code = typeof (err as { code?: unknown })?.code === 'string' ? (err as { code: string }).code : '';
    return NO_MX_CODES.includes(code) ? 'no-mx' : 'failed';
  }
}

/** What mailProvidersFor found. A domain in neither was left for a later call (MAIL_PROVIDER_LOOKUPS_PER_CALL). */
export type MailProviders = {
  /** The provider of each domain with an answer, stored or just looked up; null for a domain no known provider hosts. */
  known: Map<string, MailProvider | null>;
  /** The domains with no stored answer whose lookup failed this time. */
  failed: Set<string>;
};

/**
 * The mail provider of each of `domains`: its stored answer while that is
 * fresh, else a lookup whose answer is stored. At most
 * MAIL_PROVIDER_LOOKUPS_PER_CALL domains are looked up, those with no stored
 * answer first. A stale answer stands when its fresh lookup fails or is left
 * for a later call, so only a domain never answered for is without one.
 *
 * A domain with no MX records has no provider now, and that is not stored: a
 * domain that publishes none for a while (or does not exist yet) would
 * otherwise keep "no provider" for MAIL_PROVIDER_TTL_MS after it does.
 */
export async function mailProvidersFor(domains: string[], now: Date, resolver: MxResolver = defaultResolver()): Promise<MailProviders> {
  const wanted = Array.from(new Set(domains.filter(Boolean)));
  const known = new Map<string, MailProvider | null>();
  const failed = new Set<string>();
  if (wanted.length === 0) return { known, failed };

  const rows = await prisma.mailDomain.findMany({ where: { domain: { in: wanted } } });
  const stale: string[] = [];
  for (const row of rows) {
    known.set(row.domain, isMailProvider(row.provider) ? row.provider : null);
    if (now.getTime() - row.checkedAt.getTime() >= MAIL_PROVIDER_TTL_MS) stale.push(row.domain);
  }
  const unanswered = wanted.filter((domain) => !known.has(domain));
  const pending = [...unanswered, ...stale].slice(0, MAIL_PROVIDER_LOOKUPS_PER_CALL);

  let next = 0;
  const worker = async () => {
    while (next < pending.length) {
      const domain = pending[next++];
      const provider = await lookUpMailProvider(resolver, domain);
      if (provider === 'failed') {
        if (!known.has(domain)) failed.add(domain);
        continue;
      }
      if (provider === 'no-mx') {
        known.set(domain, null);
        continue;
      }
      known.set(domain, provider);
      await prisma.mailDomain.upsert({
        where: { domain },
        create: { domain, provider, checkedAt: now },
        update: { provider, checkedAt: now },
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(LOOKUP_CONCURRENCY, pending.length) }, worker));
  return { known, failed };
}
