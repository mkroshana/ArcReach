import { describe, it, expect } from 'vitest';
import { checkDomainMx, checkDomains, dnsUnreachable, emailDomain, type DomainCheckStatus, type DomainResolver } from '../../lib/domainCheck';

type Answer = unknown[] | string;

/**
 * A resolver answering from `answers` (records, or the error code the lookup
 * fails with); a domain with no entry fails as NXDOMAIN (ENOTFOUND) does. It
 * logs each lookup and how many were in flight at the most.
 */
function fakeResolver(answers: Record<string, { mx?: Answer; a?: Answer; ns?: Answer }>) {
  const lookups: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const answer = async (type: 'mx' | 'a' | 'ns', domain: string) => {
    lookups.push(`${type} ${domain}`);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1));
    inFlight--;
    const found = answers[domain]?.[type] ?? 'ENOTFOUND';
    if (typeof found === 'string') throw Object.assign(new Error(`query ${found} ${domain}`), { code: found });
    return found;
  };
  const resolver = {
    resolveMx: (domain: string) => answer('mx', domain),
    resolve4: (domain: string) => answer('a', domain),
    resolveNs: (zone: string) => answer('ns', zone),
  } as DomainResolver;
  return { resolver, lookups, maxInFlight: () => maxInFlight };
}

const MX = [{ exchange: 'mx.example.com', priority: 10 }];

describe('checkDomainMx (H36)', () => {
  it('is Valid when the domain has MX records, without an A lookup', async () => {
    const { resolver, lookups } = fakeResolver({ 'acme.com': { mx: MX } });

    expect(await checkDomainMx(resolver, 'acme.com')).toBe('Valid');
    expect(lookups).toEqual(['mx acme.com']);
  });

  it.each(['ENOTFOUND', 'NXDOMAIN', 'EBADNAME'])('is Invalid when the MX lookup fails with %s, without an A lookup', async (code) => {
    const { resolver, lookups } = fakeResolver({ 'gone.test': { mx: code, a: ['192.0.2.1'] } });

    expect(await checkDomainMx(resolver, 'gone.test')).toBe('Invalid');
    expect(lookups).toEqual(['mx gone.test']);
  });

  it.each(['', '.'])('is Invalid when the only MX record is a null MX (exchange %j), without an A lookup', async (exchange) => {
    const { resolver, lookups } = fakeResolver({ 'no-mail.test': { mx: [{ exchange, priority: 0 }], a: ['192.0.2.1'] } });

    expect(await checkDomainMx(resolver, 'no-mail.test')).toBe('Invalid');
    expect(lookups).toEqual(['mx no-mail.test']);
  });

  it('is Valid when a null MX is published next to a usable MX record', async () => {
    const { resolver, lookups } = fakeResolver({ 'mixed.test': { mx: [{ exchange: '', priority: 0 }, ...MX] } });

    expect(await checkDomainMx(resolver, 'mixed.test')).toBe('Valid');
    expect(lookups).toEqual(['mx mixed.test']);
  });

  it.each(['ETIMEOUT', 'ESERVFAIL', 'EREFUSED', 'ECONNREFUSED', 'ECANCELLED', ''])(
    'is Risky when the MX lookup fails with %j, without an A lookup',
    async (code) => {
      const { resolver, lookups } = fakeResolver({ 'flaky.test': { mx: code, a: ['192.0.2.1'] } });

      expect(await checkDomainMx(resolver, 'flaky.test')).toBe('Risky');
      expect(lookups).toEqual(['mx flaky.test']);
    },
  );

  it('falls back to the A record when the domain has no MX records (ENODATA or none returned)', async () => {
    const { resolver, lookups } = fakeResolver({
      'a-only.test': { mx: 'ENODATA', a: ['192.0.2.1'] },
      'empty-mx.test': { mx: [], a: ['192.0.2.2'] },
    });

    expect(await checkDomainMx(resolver, 'a-only.test')).toBe('Valid');
    expect(await checkDomainMx(resolver, 'empty-mx.test')).toBe('Valid');
    expect(lookups).toEqual(['mx a-only.test', 'a a-only.test', 'mx empty-mx.test', 'a empty-mx.test']);
  });

  it.each(['ENODATA', 'ETIMEOUT', 'ENOTFOUND'])('is Risky, never Invalid, when a domain with no MX records has no A record (%s)', async (code) => {
    const { resolver } = fakeResolver({ 'parked.test': { mx: 'ENODATA', a: code } });

    expect(await checkDomainMx(resolver, 'parked.test')).toBe('Risky');
  });

  it('is Risky when the resolver throws something that is not a DNS error', async () => {
    const resolver = {
      resolveMx: () => { throw new TypeError('bad argument'); },
      resolve4: async () => ['192.0.2.1'],
    } as unknown as DomainResolver;

    expect(await checkDomainMx(resolver, 'acme.com')).toBe('Risky');
  });
});

describe('checkDomains (H36)', () => {
  it('looks each distinct domain up once and answers by domain', async () => {
    const { resolver, lookups } = fakeResolver({ 'acme.com': { mx: MX }, 'flaky.test': { mx: 'ETIMEOUT' } });

    const results = await checkDomains(resolver, ['acme.com', 'gone.test', 'acme.com', 'flaky.test', 'acme.com']);

    expect(Object.fromEntries(results)).toEqual({ 'acme.com': 'Valid', 'gone.test': 'Invalid', 'flaky.test': 'Risky' });
    expect(lookups.filter((l) => l === 'mx acme.com')).toHaveLength(1);
  });

  it('keeps at most `concurrency` lookups in flight', async () => {
    const domains = Array.from({ length: 30 }, (_, i) => `d${i}.test`);
    const { resolver, lookups, maxInFlight } = fakeResolver(
      Object.fromEntries(domains.map((d) => [d, { mx: MX }])),
    );

    const results = await checkDomains(resolver, domains, 4);

    expect(results.size).toBe(30);
    expect(lookups).toHaveLength(30);
    expect(maxInFlight()).toBe(4);
  });

  it('makes no lookup for no domains', async () => {
    const { resolver, lookups } = fakeResolver({});

    expect((await checkDomains(resolver, [])).size).toBe(0);
    expect(lookups).toEqual([]);
  });
});

describe('dnsUnreachable', () => {
  const COM_ZONE = { 'com.': { ns: ['a.gtld-servers.net'] } };
  const statuses = (byDomain: Record<string, DomainCheckStatus>) => new Map(Object.entries(byDomain));

  it('is false, without a lookup, when no domain was looked up', async () => {
    const { resolver, lookups } = fakeResolver({});

    expect(await dnsUnreachable(resolver, statuses({}))).toBe(false);
    expect(lookups).toEqual([]);
  });

  it.each(['Valid', 'Invalid'] as const)('is false, without a lookup, when a domain came back %s: a DNS server answered', async (certain) => {
    const { resolver, lookups } = fakeResolver({});

    expect(await dnsUnreachable(resolver, statuses({ 'flaky.test': 'Risky', 'answered.test': certain }))).toBe(false);
    expect(lookups).toEqual([]);
  });

  it('is false when every domain is Risky but the com zone still resolves', async () => {
    const { resolver, lookups } = fakeResolver(COM_ZONE);

    expect(await dnsUnreachable(resolver, statuses({ 'flaky.test': 'Risky', 'parked.test': 'Risky' }))).toBe(false);
    expect(lookups).toEqual(['ns com.']);
  });

  it.each(['ECONNREFUSED', 'ETIMEOUT', 'ESERVFAIL'])('is true when every domain is Risky and the com zone lookup fails with %s', async (code) => {
    const { resolver, lookups } = fakeResolver({ 'com.': { ns: code } });

    expect(await dnsUnreachable(resolver, statuses({ 'flaky.test': 'Risky' }))).toBe(true);
    expect(lookups).toEqual(['ns com.']);
  });
});

describe('emailDomain (H36)', () => {
  it('returns the lowercased domain of an address', () => {
    expect(emailDomain('Jane@Acme.COM')).toBe('acme.com');
    expect(emailDomain(' jane@acme.com ')).toBe('acme.com');
  });

  it.each(['not-an-email', 'a@b@acme.com', '@acme.com', 'jane@', ''])('returns null for the malformed %j', (email) => {
    expect(emailDomain(email)).toBeNull();
  });
});
