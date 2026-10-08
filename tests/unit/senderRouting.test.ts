import { describe, it, expect } from 'vitest';
import {
  MAX_RECIPIENT_DOMAINS,
  NO_OPEN_SENDER_ERROR,
  effectiveRecipientDomains,
  entryLabel,
  entryProvider,
  needsMailProvider,
  parseRecipientDomains,
  providerEntry,
  recipientDomainOf,
  routesUseProviders,
  routingSummary,
  sendersForRecipient,
  storedRecipientDomains,
  unroutedPoolError,
} from '../../lib/senderRouting';

describe('parseRecipientDomains', () => {
  it('stores each domain trimmed and lowercased, without a leading @, once', () => {
    expect(parseRecipientDomains([' Gmail.com ', '@googlemail.com', 'GMAIL.COM'])).toEqual({
      domains: ['gmail.com', 'googlemail.com'],
      error: null,
    });
  });

  it('splits domains typed or pasted together', () => {
    expect(parseRecipientDomains(['gmail.com, googlemail.com;outlook.com hotmail.com'])).toEqual({
      domains: ['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com'],
      error: null,
    });
  });

  it('takes an empty list, which clears the mailbox of its list', () => {
    expect(parseRecipientDomains([])).toEqual({ domains: [], error: null });
    expect(parseRecipientDomains(['  ', ','])).toEqual({ domains: [], error: null });
  });

  it('refuses the whole list for an entry that is no domain name, naming it', () => {
    for (const bad of ['gmail', 'ann@gmail.com', 'gmail..com', '-gmail.com', 'gmail.c', '192.168.0.1', 'gmäil.com', '*.gmail.com']) {
      expect(parseRecipientDomains(['outlook.com', bad])).toEqual({
        domains: null,
        error: `"${bad}" is not a domain name. Enter Recipient Domains such as gmail.com.`,
      });
    }
  });

  it('refuses anything but a list of strings', () => {
    for (const value of [undefined, null, 'gmail.com', { 0: 'gmail.com' }, ['gmail.com', 7], [['gmail.com']]]) {
      expect(parseRecipientDomains(value)).toEqual({ domains: null, error: 'Recipient Domains must be a list of domain names.' });
    }
  });

  it('refuses more domains than a list holds', () => {
    const domains = Array.from({ length: MAX_RECIPIENT_DOMAINS + 1 }, (_, i) => `d${i}.test`);
    expect(parseRecipientDomains(domains.slice(0, MAX_RECIPIENT_DOMAINS)).error).toBeNull();
    expect(parseRecipientDomains(domains)).toEqual({ domains: null, error: `Recipient Domains takes at most ${MAX_RECIPIENT_DOMAINS} domains.` });
  });
});

describe('effectiveRecipientDomains', () => {
  it("is the mailbox's own list when it has one, whatever the campaign's", () => {
    expect(effectiveRecipientDomains(['gmail.com'], ['outlook.com'])).toEqual(['gmail.com']);
    expect(effectiveRecipientDomains(['gmail.com'], [])).toEqual(['gmail.com']);
  });

  it("is the campaign's list for a mailbox with none of its own", () => {
    expect(effectiveRecipientDomains([], ['outlook.com'])).toEqual(['outlook.com']);
    expect(effectiveRecipientDomains(undefined, ['outlook.com'])).toEqual(['outlook.com']);
  });

  it('is empty when neither has one, also for rows loaded without the column', () => {
    expect(effectiveRecipientDomains([], [])).toEqual([]);
    expect(effectiveRecipientDomains(undefined, undefined)).toEqual([]);
    expect(storedRecipientDomains(null)).toEqual([]);
  });
});

describe('recipientDomainOf', () => {
  it('is the part after the @, lowercased', () => {
    expect(recipientDomainOf(' Ann.Lee@Gmail.COM ')).toBe('gmail.com');
  });

  it('is empty for a value with no @', () => {
    expect(recipientDomainOf('gmail.com')).toBe('');
    expect(recipientDomainOf(null)).toBe('');
  });
});

describe('sendersForRecipient', () => {
  const gmail = { id: 'mb-gmail' };
  const microsoft = { id: 'mb-microsoft' };
  const open = { id: 'mb-open' };
  const open2 = { id: 'mb-open-2' };
  const pool = [open, gmail, microsoft, open2];
  const routes = new Map([
    ['mb-gmail', ['gmail.com', 'googlemail.com']],
    ['mb-microsoft', ['outlook.com']],
    ['mb-open', []],
  ]);

  it('gives a lead at a listed domain to the mailbox that lists it, and to no other', () => {
    expect(sendersForRecipient(pool, routes, 'ann@gmail.com')).toEqual([gmail]);
    expect(sendersForRecipient(pool, routes, 'Ann@GoogleMail.com')).toEqual([gmail]);
    expect(sendersForRecipient(pool, routes, 'bo@outlook.com')).toEqual([microsoft]);
  });

  it('gives a lead at any other domain to the mailboxes with no list, and to none with one', () => {
    expect(sendersForRecipient(pool, routes, 'cy@acme.test')).toEqual([open, open2]);
  });

  it('matches the domain exactly, not its subdomains or names it ends', () => {
    expect(sendersForRecipient(pool, routes, 'dee@mail.gmail.com')).toEqual([open, open2]);
    expect(sendersForRecipient(pool, routes, 'eve@notgmail.com')).toEqual([open, open2]);
  });

  it('shares a domain between the mailboxes that both list it', () => {
    const shared = new Map([['mb-gmail', ['gmail.com']], ['mb-microsoft', ['gmail.com', 'outlook.com']]]);
    expect(sendersForRecipient(pool, shared, 'ann@gmail.com')).toEqual([gmail, microsoft]);
  });

  it('gives every lead to the whole pool while no mailbox has a list', () => {
    expect(sendersForRecipient(pool, new Map(), 'ann@gmail.com')).toEqual(pool);
  });

  it('gives a lead at an unlisted domain to no mailbox when every mailbox has a list', () => {
    const limited = [gmail, microsoft];
    expect(sendersForRecipient(limited, routes, 'cy@acme.test')).toEqual([]);
    expect(sendersForRecipient(limited, routes, 'ann@gmail.com')).toEqual([gmail]);
  });
});

describe('unroutedPoolError', () => {
  const pool = [{ id: 'mb-1' }, { id: 'mb-2' }];

  it('is null while a mailbox of the pool has no list', () => {
    expect(unroutedPoolError(pool, new Map())).toBeNull();
    expect(unroutedPoolError(pool, new Map([['mb-1', ['gmail.com']], ['mb-2', []]]))).toBeNull();
  });

  it('names the problem once every mailbox has one', () => {
    expect(unroutedPoolError(pool, new Map([['mb-1', ['gmail.com']], ['mb-2', ['outlook.com']]]))).toBe(NO_OPEN_SENDER_ERROR);
    expect(unroutedPoolError([{ id: 'mb-1' }], new Map([['mb-1', ['gmail.com']]]))).toBe(NO_OPEN_SENDER_ERROR);
  });

  it('is null for an empty pool, which has its own error', () => {
    expect(unroutedPoolError([], new Map())).toBeNull();
  });
});

describe('routingSummary', () => {
  const pool = [
    { id: 'mb-1', emailAddress: 'team@acme.test' },
    { id: 'mb-2', emailAddress: 'chui@other.test' },
    { id: 'mb-3', emailAddress: 'steve@acme.test' },
  ];

  it('is null while no mailbox has a list', () => {
    expect(routingSummary(pool, new Map())).toBeNull();
  });

  it('says which mailbox takes the listed domains and which take the rest', () => {
    expect(routingSummary(pool, new Map([['mb-2', ['googlemail.com', 'gmail.com']]]))).toBe(
      'Leads at gmail.com and googlemail.com go out from chui@other.test; leads at every other domain go out from team@acme.test and steve@acme.test.',
    );
  });

  it('groups mailboxes with the same list', () => {
    expect(routingSummary(pool, new Map([['mb-1', ['gmail.com']], ['mb-2', ['gmail.com']]]))).toBe(
      'Leads at gmail.com go out from team@acme.test and chui@other.test; leads at every other domain go out from steve@acme.test.',
    );
  });

  it('says so when no mailbox takes the rest', () => {
    expect(routingSummary(pool.slice(0, 1), new Map([['mb-1', ['gmail.com']]]))).toBe(
      'Leads at gmail.com go out from team@acme.test; leads at every other domain have no mailbox to send from.',
    );
  });
});

describe('mail provider entries', () => {
  it('names a provider by its entry, which no domain name can be', () => {
    expect(providerEntry('google')).toBe('provider:google');
    expect(entryProvider('provider:google')).toBe('google');
    expect(entryProvider('gmail.com')).toBeNull();
    expect(entryProvider('provider:zoho')).toBeNull();
  });

  it('shows a provider by its name and what it covers, a domain as it is', () => {
    expect(entryLabel('provider:google')).toBe('Google (Gmail, Google Workspace)');
    expect(entryLabel('provider:microsoft')).toBe('Microsoft (Outlook, Hotmail, Microsoft 365)');
    expect(entryLabel('gmail.com')).toBe('gmail.com');
  });

  it('takes a provider by its entry or by its name alone, beside domains, once each', () => {
    expect(parseRecipientDomains(['provider:google', 'acme.com', 'Google', 'YAHOO'])).toEqual({
      domains: ['provider:google', 'acme.com', 'provider:yahoo'],
      error: null,
    });
    expect(parseRecipientDomains(['microsoft, gmail.com'])).toEqual({ domains: ['provider:microsoft', 'gmail.com'], error: null });
  });

  it('refuses a provider it does not know', () => {
    expect(parseRecipientDomains(['provider:zoho'])).toEqual({
      domains: null,
      error: '"provider:zoho" is not a domain name. Enter Recipient Domains such as gmail.com.',
    });
  });
});

describe('sendersForRecipient with mail providers', () => {
  const google = { id: 'mb-google' };
  const acme = { id: 'mb-acme' };
  const open = { id: 'mb-open' };
  const pool = [open, google, acme];
  const routes = new Map([
    ['mb-google', ['provider:google']],
    ['mb-acme', ['acme.test']],
    ['mb-open', []],
  ]);

  it("gives a lead to the mailbox that lists the provider hosting its domain, a company's own domain included", () => {
    expect(sendersForRecipient(pool, routes, 'ann@gmail.com', 'google')).toEqual([google]);
    expect(sendersForRecipient(pool, routes, 'bo@hosted-at-google.test', 'google')).toEqual([google]);
  });

  it('gives a lead to the mailbox that lists its domain before the one that lists its provider', () => {
    expect(sendersForRecipient(pool, routes, 'cy@acme.test', 'google')).toEqual([acme]);
  });

  it('gives a lead at another provider, or at none, to the mailboxes with no list', () => {
    expect(sendersForRecipient(pool, routes, 'dee@outlook.com', 'microsoft')).toEqual([open]);
    expect(sendersForRecipient(pool, routes, 'eve@own-server.test', null)).toEqual([open]);
    expect(sendersForRecipient(pool, routes, 'eve@own-server.test')).toEqual([open]);
  });

  it('shares a provider between the mailboxes that both list it', () => {
    const shared = new Map([['mb-google', ['provider:google']], ['mb-acme', ['provider:google', 'acme.test']]]);
    expect(sendersForRecipient(pool, shared, 'ann@gmail.com', 'google')).toEqual([google, acme]);
  });

  it('gives a lead no mailbox when its provider is listed nowhere and every mailbox has a list', () => {
    expect(sendersForRecipient([google, acme], routes, 'dee@outlook.com', 'microsoft')).toEqual([]);
  });
});

describe('needsMailProvider', () => {
  const pool = [{ id: 'mb-google' }, { id: 'mb-acme' }, { id: 'mb-open' }];
  const routes = new Map([['mb-google', ['provider:google']], ['mb-acme', ['acme.test']], ['mb-open', []]]);

  it('is true where a mailbox lists a provider and none lists the domain itself', () => {
    expect(needsMailProvider(pool, routes, 'ann@gmail.com')).toBe(true);
    expect(routesUseProviders(routes)).toBe(true);
  });

  it('is false for a domain a mailbox lists, which decides it alone', () => {
    expect(needsMailProvider(pool, routes, 'cy@acme.test')).toBe(false);
  });

  it('is false for a pool with no provider in any list', () => {
    const domainsOnly = new Map([['mb-google', ['gmail.com']], ['mb-open', []]]);
    expect(needsMailProvider(pool, domainsOnly, 'ann@gmail.com')).toBe(false);
    expect(needsMailProvider(pool, domainsOnly, 'bo@other.test')).toBe(false);
    expect(routesUseProviders(domainsOnly)).toBe(false);
    expect(routesUseProviders(new Map())).toBe(false);
  });
});

describe('routingSummary with mail providers', () => {
  const pool = [
    { id: 'mb-1', emailAddress: 'team@acme.test' },
    { id: 'mb-2', emailAddress: 'chui@other.test' },
  ];

  it('names a provider as every address it hosts, after the domains of the same list', () => {
    expect(routingSummary(pool, new Map([['mb-2', ['provider:google']]]))).toBe(
      'Leads at any Google-hosted address go out from chui@other.test; leads at every other domain go out from team@acme.test.',
    );
    expect(routingSummary(pool, new Map([['mb-2', ['provider:microsoft', 'yahoo.com', 'provider:google']]]))).toBe(
      'Leads at yahoo.com, any Google-hosted address and any Microsoft-hosted address go out from chui@other.test; leads at every other domain go out from team@acme.test.',
    );
  });
});
