import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

const fake = vi.hoisted(() => ({
  mailDomain: { findMany: vi.fn(), upsert: vi.fn() },
}));

vi.mock('../../lib/db', () => ({ prisma: fake }));

import { isMailProvider, mailProviderOfMx } from '../../lib/mailProvider';
import {
  MAIL_PROVIDER_LOOKUPS_PER_CALL,
  MAIL_PROVIDER_TTL_MS,
  type MxResolver,
  lookUpMailProvider,
  mailProvidersFor,
} from '../../lib/mailProviderLookup';

const mx = (...exchanges: Array<string | [string, number]>) =>
  exchanges.map((entry, index) => (typeof entry === 'string' ? { exchange: entry, priority: (index + 1) * 10 } : { exchange: entry[0], priority: entry[1] }));

describe('mailProviderOfMx', () => {
  it('names Google for Gmail and for a company domain whose mail Google hosts', () => {
    expect(mailProviderOfMx(mx('gmail-smtp-in.l.google.com', 'alt1.gmail-smtp-in.l.google.com'))).toBe('google');
    expect(mailProviderOfMx(mx('aspmx.l.google.com', 'alt1.aspmx.l.google.com'))).toBe('google');
    expect(mailProviderOfMx(mx('smtp.google.com'))).toBe('google');
    expect(mailProviderOfMx(mx('ASPMX2.GOOGLEMAIL.COM.'))).toBe('google');
  });

  it('names Microsoft for Outlook, Hotmail and Microsoft 365 domains', () => {
    expect(mailProviderOfMx(mx('outlook-com.olc.protection.outlook.com'))).toBe('microsoft');
    expect(mailProviderOfMx(mx('contoso-com.mail.protection.outlook.com'))).toBe('microsoft');
    expect(mailProviderOfMx(mx('contoso-com.o-v1.mx.microsoft'))).toBe('microsoft');
  });

  it('names Yahoo for Yahoo and AOL', () => {
    expect(mailProviderOfMx(mx('mta5.am0.yahoodns.net', 'mta6.am0.yahoodns.net'))).toBe('yahoo');
    expect(mailProviderOfMx(mx('mx-aol.mail.gm0.yahoodns.net'))).toBe('yahoo');
  });

  it('names none for other mail servers, a security gateway among them', () => {
    expect(mailProviderOfMx(mx('mx01.mail.icloud.com'))).toBeNull();
    expect(mailProviderOfMx(mx('route1.mx.cloudflare.net'))).toBeNull();
    expect(mailProviderOfMx(mx('mxa-00148501.gslb.pphosted.com'))).toBeNull();
    // A name that only ends in the same letters is not the provider's
    expect(mailProviderOfMx(mx('mail.notgoogle.com'))).toBeNull();
    expect(mailProviderOfMx(mx('google.com.evil.test'))).toBeNull();
  });

  it('goes by the servers mail is delivered to first, not a backup at a provider', () => {
    expect(mailProviderOfMx(mx(['mail.acme.test', 5], ['aspmx.l.google.com', 20]))).toBeNull();
    expect(mailProviderOfMx(mx(['aspmx.l.google.com', 1], ['mail.acme.test', 10]))).toBe('google');
    // Two first servers: a provider's one names the provider
    expect(mailProviderOfMx(mx(['mail.acme.test', 10], ['aspmx.l.google.com', 10]))).toBe('google');
  });

  it('names none for no records or a null MX', () => {
    expect(mailProviderOfMx([])).toBeNull();
    expect(mailProviderOfMx(mx(['', 0]))).toBeNull();
    expect(mailProviderOfMx(mx(['.', 0]))).toBeNull();
  });

  it('knows its own providers only', () => {
    expect(isMailProvider('google')).toBe(true);
    expect(isMailProvider('Google')).toBe(false);
    expect(isMailProvider('toString')).toBe(false);
    expect(isMailProvider(null)).toBe(false);
  });
});

const dnsError = (code: string) => Object.assign(new Error(code), { code });

describe('lookUpMailProvider', () => {
  it('answers the provider the MX records name', async () => {
    const resolver = { resolveMx: vi.fn().mockResolvedValue(mx('aspmx.l.google.com')) };
    expect(await lookUpMailProvider(resolver, 'acme.test')).toBe('google');
    expect(resolver.resolveMx).toHaveBeenCalledWith('acme.test');
  });

  it("answers 'no-mx' for a domain that does not exist or has no MX records", async () => {
    for (const code of ['ENOTFOUND', 'ENODATA', 'EBADNAME']) {
      expect(await lookUpMailProvider({ resolveMx: vi.fn().mockRejectedValue(dnsError(code)) }, 'acme.test')).toBe('no-mx');
    }
  });

  it("answers 'failed' for a lookup that got no answer", async () => {
    for (const code of ['ETIMEOUT', 'ESERVFAIL', 'ECONNREFUSED', '']) {
      expect(await lookUpMailProvider({ resolveMx: vi.fn().mockRejectedValue(dnsError(code)) }, 'acme.test')).toBe('failed');
    }
  });
});

describe('mailProvidersFor', () => {
  const NOW = new Date('2026-10-08T12:00:00Z');
  const ago = (ms: number) => new Date(NOW.getTime() - ms);
  /** The MailDomain table. */
  let stored: Map<string, { domain: string; provider: string | null; checkedAt: Date }>;
  /** What each domain's MX lookup answers: its records, or an error code. */
  let dns: Record<string, ReturnType<typeof mx> | string>;
  let resolver: { resolveMx: Mock<MxResolver['resolveMx']> };

  beforeEach(() => {
    vi.clearAllMocks();
    stored = new Map();
    dns = {};
    resolver = {
      resolveMx: vi.fn<MxResolver['resolveMx']>(async (domain) => {
        const answer = dns[domain] ?? 'ENOTFOUND';
        if (typeof answer === 'string') throw dnsError(answer);
        return answer;
      }),
    };
    fake.mailDomain.findMany.mockImplementation(async ({ where }: any) => where.domain.in.filter((d: string) => stored.has(d)).map((d: string) => ({ ...stored.get(d)! })));
    fake.mailDomain.upsert.mockImplementation(async ({ where, create, update }: any) => {
      stored.set(where.domain, stored.has(where.domain) ? { ...stored.get(where.domain)!, ...update } : { ...create });
    });
  });

  it('looks a new domain up once and keeps the answer, a domain with no provider included', async () => {
    dns = { 'acme.test': mx('aspmx.l.google.com'), 'own.test': mx('mail.own.test') };

    const first = await mailProvidersFor(['acme.test', 'own.test', 'acme.test'], NOW, resolver);
    expect(first.known).toEqual(new Map([['acme.test', 'google'], ['own.test', null]]));
    expect(first.failed.size).toBe(0);
    expect(resolver.resolveMx).toHaveBeenCalledTimes(2);
    expect(stored.get('acme.test')).toEqual({ domain: 'acme.test', provider: 'google', checkedAt: NOW });
    expect(stored.get('own.test')).toEqual({ domain: 'own.test', provider: null, checkedAt: NOW });

    const second = await mailProvidersFor(['acme.test', 'own.test'], new Date(NOW.getTime() + 60_000), resolver);
    expect(second.known).toEqual(first.known);
    expect(resolver.resolveMx).toHaveBeenCalledTimes(2);
  });

  it('answers none for a domain with no MX records without storing it, so it is looked up again once it has some', async () => {
    dns = { 'new.test': 'ENODATA' };

    const first = await mailProvidersFor(['new.test', 'missing.test'], NOW, resolver);
    expect(first.known).toEqual(new Map([['new.test', null], ['missing.test', null]]));
    expect(first.failed.size).toBe(0);
    expect(fake.mailDomain.upsert).not.toHaveBeenCalled();

    dns['new.test'] = mx('aspmx.l.google.com');
    const second = await mailProvidersFor(['new.test'], NOW, resolver);
    expect(second.known).toEqual(new Map([['new.test', 'google']]));
    expect(stored.get('new.test')).toMatchObject({ provider: 'google' });
  });

  it('leaves a domain whose lookup failed without an answer, storing nothing, so it is looked up again', async () => {
    dns = { 'slow.test': 'ETIMEOUT', 'acme.test': mx('aspmx.l.google.com') };

    const result = await mailProvidersFor(['slow.test', 'acme.test'], NOW, resolver);
    expect(result.known).toEqual(new Map([['acme.test', 'google']]));
    expect(result.failed).toEqual(new Set(['slow.test']));
    expect(stored.has('slow.test')).toBe(false);

    dns['slow.test'] = mx('contoso-com.mail.protection.outlook.com');
    const again = await mailProvidersFor(['slow.test'], NOW, resolver);
    expect(again.known).toEqual(new Map([['slow.test', 'microsoft']]));
  });

  it('looks an answer up again once it is older than the time it stands, and stores the new one', async () => {
    stored.set('moved.test', { domain: 'moved.test', provider: 'google', checkedAt: ago(MAIL_PROVIDER_TTL_MS) });
    stored.set('fresh.test', { domain: 'fresh.test', provider: 'google', checkedAt: ago(MAIL_PROVIDER_TTL_MS - 1) });
    dns = { 'moved.test': mx('contoso-com.mail.protection.outlook.com'), 'fresh.test': mx('contoso-com.mail.protection.outlook.com') };

    const result = await mailProvidersFor(['moved.test', 'fresh.test'], NOW, resolver);
    expect(result.known).toEqual(new Map([['moved.test', 'microsoft'], ['fresh.test', 'google']]));
    expect(resolver.resolveMx).toHaveBeenCalledTimes(1);
    expect(stored.get('moved.test')).toMatchObject({ provider: 'microsoft', checkedAt: NOW });
  });

  it('keeps an old answer when its fresh lookup fails', async () => {
    stored.set('old.test', { domain: 'old.test', provider: 'yahoo', checkedAt: ago(MAIL_PROVIDER_TTL_MS * 2) });
    dns = { 'old.test': 'ESERVFAIL' };

    const result = await mailProvidersFor(['old.test'], NOW, resolver);
    expect(result.known).toEqual(new Map([['old.test', 'yahoo']]));
    expect(result.failed.size).toBe(0);
    expect(fake.mailDomain.upsert).not.toHaveBeenCalled();
  });

  it('reads a stored provider it no longer knows as none', async () => {
    stored.set('legacy.test', { domain: 'legacy.test', provider: 'zoho', checkedAt: NOW });
    expect((await mailProvidersFor(['legacy.test'], NOW, resolver)).known).toEqual(new Map([['legacy.test', null]]));
  });

  it('looks up no more domains than one call may, new ones before old answers, and leaves the rest for a later call', async () => {
    const fresh = Array.from({ length: MAIL_PROVIDER_LOOKUPS_PER_CALL + 5 }, (_, i) => `new${i}.test`);
    stored.set('old.test', { domain: 'old.test', provider: 'yahoo', checkedAt: ago(MAIL_PROVIDER_TTL_MS * 2) });
    for (const domain of fresh) dns[domain] = mx('aspmx.l.google.com');

    const result = await mailProvidersFor(['old.test', ...fresh], NOW, resolver);
    expect(resolver.resolveMx).toHaveBeenCalledTimes(MAIL_PROVIDER_LOOKUPS_PER_CALL);
    expect(resolver.resolveMx).not.toHaveBeenCalledWith('old.test');
    // The stale answer stands, and the domains past the limit are in neither set
    expect(result.known.get('old.test')).toBe('yahoo');
    expect(result.known.size).toBe(MAIL_PROVIDER_LOOKUPS_PER_CALL + 1);
    expect(result.failed.size).toBe(0);
  });

  it('reads and looks up nothing for no domains', async () => {
    const result = await mailProvidersFor(['', ''], NOW, resolver);
    expect(result.known.size).toBe(0);
    expect(fake.mailDomain.findMany).not.toHaveBeenCalled();
    expect(resolver.resolveMx).not.toHaveBeenCalled();
  });
});
