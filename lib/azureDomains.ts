/**
 * Helpers for resolving the set of verified Azure Communication Services sender
 * domains and the from-address for an outgoing message.
 *
 * Domains are stored as a JSON string[] on GlobalSettings.azureSenderDomains.
 * The legacy single-value GlobalSettings.azureSenderDomain is honored as a
 * read-only fallback so existing configurations keep working after migration.
 */

type DomainSettings = {
  azureSenderDomains?: unknown;
  azureSenderDomain?: string | null;
};

/**
 * Returns the normalized, de-duplicated list of verified sender domains.
 * Falls back to the legacy single-domain field when the array is empty.
 */
export function getVerifiedDomains(settings: DomainSettings | null | undefined): string[] {
  const list = Array.isArray(settings?.azureSenderDomains) ? settings!.azureSenderDomains : [];
  const normalized = (list as unknown[])
    .map((d) => String(d).trim().toLowerCase())
    .filter(Boolean);

  if (normalized.length === 0 && settings?.azureSenderDomain) {
    return [settings.azureSenderDomain.trim().toLowerCase()];
  }

  return [...new Set(normalized)];
}

/**
 * Resolves the Azure from-address for a sender account by using the account's
 * own email address, after validating its domain is in the verified list.
 * Throws a clear error when the domain is not verified.
 */
export function resolveAzureFromAddress(
  senderEmail: string | null | undefined,
  settings: DomainSettings | null | undefined
): string {
  const email = (senderEmail || '').trim();
  const domain = email.split('@')[1]?.toLowerCase();
  const verified = getVerifiedDomains(settings);

  if (!domain) {
    throw new Error(`Sender email "${senderEmail ?? ''}" is not a valid address.`);
  }
  if (!verified.includes(domain)) {
    throw new Error(
      `Sender domain "${domain}" is not in the verified Azure sender domains list.`
    );
  }
  return email;
}
