/**
 * The mail providers a Recipient Domains list can name (lib/senderRouting),
 * and how one is told from a domain's MX records: the provider whose servers
 * take the domain's mail. So 'google' is gmail.com and every company domain
 * whose mail Google hosts.
 *
 * A domain behind a mail security gateway (Proofpoint, Mimecast and the like)
 * publishes the gateway's servers, not its mailbox provider's, so it has no
 * provider here.
 *
 * Has no Node-only imports so the pages can use it.
 */

/** Each provider's name, what it covers, and the names its mail servers end in. */
export const MAIL_PROVIDERS = {
  google: { label: 'Google', covers: 'Gmail, Google Workspace', mxSuffixes: ['google.com', 'googlemail.com'] },
  microsoft: { label: 'Microsoft', covers: 'Outlook, Hotmail, Microsoft 365', mxSuffixes: ['protection.outlook.com', 'mx.microsoft'] },
  yahoo: { label: 'Yahoo', covers: 'Yahoo, AOL', mxSuffixes: ['yahoodns.net'] },
} as const;

export type MailProvider = keyof typeof MAIL_PROVIDERS;

export const MAIL_PROVIDER_KEYS = Object.keys(MAIL_PROVIDERS) as MailProvider[];

export function isMailProvider(value: unknown): value is MailProvider {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(MAIL_PROVIDERS, value);
}

/** A null MX (RFC 7505), the record of a domain that accepts no mail: its exchange is the root name. */
function isNullMx(exchange: string): boolean {
  return exchange === '' || exchange === '.';
}

function providerOfHost(exchange: string): MailProvider | null {
  const host = exchange.toLowerCase().replace(/\.$/, '');
  for (const provider of MAIL_PROVIDER_KEYS) {
    if (MAIL_PROVIDERS[provider].mxSuffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) return provider;
  }
  return null;
}

/**
 * The provider a domain's MX records name, or null when it is none of
 * MAIL_PROVIDERS. Only the records mail is delivered to first count (the
 * lowest priority number): a backup server at a provider does not make the
 * domain that provider's.
 */
export function mailProviderOfMx(records: Array<{ exchange: string; priority: number }>): MailProvider | null {
  const servers = records.filter((record) => !isNullMx(record.exchange));
  if (servers.length === 0) return null;
  const first = Math.min(...servers.map((record) => record.priority));
  for (const record of servers) {
    if (record.priority !== first) continue;
    const provider = providerOfHost(record.exchange);
    if (provider) return provider;
  }
  return null;
}
