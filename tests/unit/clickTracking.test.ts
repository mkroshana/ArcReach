import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('../../lib/db', () => ({
  prisma: {
    emailDispatch: { findUnique: vi.fn() },
    emailEvent: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
  },
}));

import { prisma } from '../../lib/db';
import { GET as clickGet, HEAD as clickHead } from '../../app/api/track/click/[dispatchId]/route';
import { GET as openGet, HEAD as openHead } from '../../app/api/track/open/[dispatchId]/route';
import { applyEmailTracking, onPreResetLinkDomain, PRE_RESET_LINK_DOMAINS } from '../../lib/emailTracking';
import { signSession } from '../../lib/session';
import * as jose from 'jose';

const mocked = prisma as any;

const DISPATCH_ID = 'd-1';
const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const IPHONE_MAIL = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const TEMPLATE =
  '<p>Book at <a href="https://calendly.com/acme/demo">Calendly</a>, ' +
  'read <a href="https://acme.test/offer?utm_source=email&amp;utm_campaign=q4">the offer</a>, ' +
  'see <a href="/pricing">pricing</a> or <a href="javascript:alert(1)">this</a>.</p>';

/** The dispatch as the send engine stores it: the final tracked body, accepted by ACS an hour ago. */
function storeDispatch(
  body: string | null = applyEmailTracking(TEMPLATE, DISPATCH_ID, true, true, true, 'tok'),
  fields: Record<string, unknown> = {}
) {
  mocked.emailDispatch.findUnique.mockResolvedValue({
    id: DISPATCH_ID,
    messageId: 'm-1',
    status: 'Sent',
    sentAt: new Date(Date.now() - 3600_000),
    acceptedAt: new Date(Date.now() - 3590_000),
    body,
    ...fields,
  });
}

function request(url: string | null, method = 'GET', dispatchId = DISPATCH_ID, userAgent: string | null = CHROME): NextRequest {
  const query = url === null ? '' : `?url=${encodeURIComponent(url)}`;
  return new NextRequest(`http://localhost/api/track/click/${dispatchId}${query}`, {
    method,
    headers: userAgent === null ? {} : { 'user-agent': userAgent },
  });
}

const ctx = (dispatchId = DISPATCH_ID) => ({ params: Promise.resolve({ dispatchId }) });

/** The url a recipient's mail client sends for the link to `target` in the stored body. */
function trackedUrlFor(target: string): string {
  const body = applyEmailTracking(TEMPLATE, DISPATCH_ID, true, false, true);
  for (const [, href] of body.matchAll(/href="([^"]+)"/g)) {
    const url = new URL(href).searchParams.get('url');
    if (url === target) return url;
  }
  throw new Error(`no tracked link for ${target}`);
}

function expectNeutralPage(res: Response, status = 404) {
  expect(res.status).toBe(status);
  expect(res.headers.get('location')).toBeNull();
  expect(res.headers.get('content-type')).toContain('text/html');
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.APP_URL;
  mocked.emailEvent.findFirst.mockResolvedValue(null);
  mocked.emailEvent.create.mockImplementation(async ({ data }: any) => ({ id: 'e-new', ...data, timestamp: new Date() }));
  storeDispatch();
});

describe('click tracking redirects only to links the email sent (H23)', () => {
  it('records the click and redirects for a link in the stored body', async () => {
    const res = await clickGet(request(trackedUrlFor('https://calendly.com/acme/demo')), ctx());

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('https://calendly.com/acme/demo');
    expect(mocked.emailEvent.create).toHaveBeenCalledWith({
      data: { messageId: 'm-1', eventType: 'click', clickedUrl: 'https://calendly.com/acme/demo' },
    });
  });

  it.each([
    ['a prefix of a sent link', 'https://calendly.co'],
    ['a sent link with more appended', 'https://calendly.com/acme/demo.evil.test'],
    ['an arbitrary value', '1'],
    ['a host the email never linked to', 'https://evil.test/'],
  ])('shows the neutral page and records nothing for %s', async (_label, url) => {
    const res = await clickGet(request(url), ctx());

    expectNeutralPage(res);
    expect(mocked.emailEvent.findFirst).not.toHaveBeenCalled();
    expect(mocked.emailEvent.create).not.toHaveBeenCalled();
  });

  it('shows the neutral page when the url parameter is missing', async () => {
    expectNeutralPage(await clickGet(request(null), ctx()));
    expect(mocked.emailDispatch.findUnique).not.toHaveBeenCalled();
  });

  it('never redirects to a sent link whose scheme is not http(s)', async () => {
    const res = await clickGet(request('javascript:alert(1)'), ctx());

    expectNeutralPage(res);
    expect(mocked.emailEvent.create).not.toHaveBeenCalled();
  });

  it('keeps one click row per link: a repeat click redirects but adds no row', async () => {
    mocked.emailEvent.findFirst.mockResolvedValue({ id: 'e-1' });

    const res = await clickGet(request('https://calendly.com/acme/demo'), ctx());

    expect(res.headers.get('location')).toBe('https://calendly.com/acme/demo');
    expect(mocked.emailEvent.findFirst).toHaveBeenCalledWith({
      where: { messageId: 'm-1', eventType: 'click', clickedUrl: 'https://calendly.com/acme/demo' },
    });
    expect(mocked.emailEvent.create).not.toHaveBeenCalled();
  });

  it('matches a body stored before its links were rewritten (a send still Sending or reconciled)', async () => {
    storeDispatch(TEMPLATE);

    const res = await clickGet(request('https://calendly.com/acme/demo'), ctx());

    expect(res.headers.get('location')).toBe('https://calendly.com/acme/demo');
    expect(mocked.emailEvent.create).toHaveBeenCalledTimes(1);
  });

  it('still redirects when recording the click fails', async () => {
    mocked.emailEvent.create.mockRejectedValue(new Error('db down'));

    const res = await clickGet(request('https://calendly.com/acme/demo'), ctx());

    expect(res.headers.get('location')).toBe('https://calendly.com/acme/demo');
  });
});

describe('&amp; in tracked links (M32)', () => {
  it('redirects to the decoded url, keeping every query parameter', async () => {
    const url = trackedUrlFor('https://acme.test/offer?utm_source=email&utm_campaign=q4');

    const res = await clickGet(request(url), ctx());

    const location = new URL(res.headers.get('location')!);
    expect(location.searchParams.get('utm_campaign')).toBe('q4');
    expect(location.searchParams.has('amp;utm_campaign')).toBe(false);
  });

  it('decodes &amp; in links sent before the fix, and records them as the same link', async () => {
    const raw = 'https://acme.test/offer?utm_source=email&amp;utm_campaign=q4';
    storeDispatch(`<a href="http://localhost:3000/api/track/click/${DISPATCH_ID}?url=${encodeURIComponent(raw)}">x</a>`);

    const res = await clickGet(request(raw), ctx());

    expect(res.headers.get('location')).toBe('https://acme.test/offer?utm_source=email&utm_campaign=q4');
    expect(mocked.emailEvent.create).toHaveBeenCalledWith({
      data: { messageId: 'm-1', eventType: 'click', clickedUrl: 'https://acme.test/offer?utm_source=email&utm_campaign=q4' },
    });
  });
});

describe('missing dispatches and relative links (M33)', () => {
  it('shows the neutral page, not the app, when the dispatch is gone', async () => {
    mocked.emailDispatch.findUnique.mockResolvedValue(null);

    const res = await clickGet(request('https://acme.test/offer?utm_source=email&utm_campaign=q4', 'GET', 'd-gone'), ctx('d-gone'));

    expectNeutralPage(res);
    expect(await res.text()).toContain('Link Unavailable');
    expect(mocked.emailEvent.create).not.toHaveBeenCalled();
  });

  it('shows a try-again page, never a 500, when the dispatch cannot be looked up', async () => {
    mocked.emailDispatch.findUnique.mockRejectedValue(new Error('db down'));

    expectNeutralPage(await clickGet(request('https://calendly.com/acme/demo'), ctx()), 503);
  });

  it('resolves a relative link against APP_URL instead of throwing', async () => {
    process.env.APP_URL = 'https://app.acme.test';

    const res = await clickGet(request('/pricing'), ctx());

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('https://app.acme.test/pricing');
    expect(mocked.emailEvent.create).toHaveBeenCalledWith({
      data: { messageId: 'm-1', eventType: 'click', clickedUrl: '/pricing' },
    });
  });
});

describe('links in mail sent before the campaign history reset (reset D2)', () => {
  const GONE = 'd-gone';

  beforeEach(() => {
    mocked.emailDispatch.findUnique.mockResolvedValue(null);
  });

  it.each([
    ['the domain itself', 'https://jobpromax.com/', 'https://jobpromax.com/'],
    ['a www subdomain', 'https://www.jobpromax.com/jobs?utm_source=email', 'https://www.jobpromax.com/jobs?utm_source=email'],
    ['thejobhelpers.com', 'https://thejobhelpers.com/hr', 'https://thejobhelpers.com/hr'],
    ['a Calendly booking link', 'https://calendly.com/steve-jpm/30min', 'https://calendly.com/steve-jpm/30min'],
    ['a deeper subdomain', 'https://app.calendly.com/s/abc', 'https://app.calendly.com/s/abc'],
    ['plain http', 'http://www.thejobhelpers.com/', 'http://www.thejobhelpers.com/'],
    ['an upper-case host', 'https://WWW.JobProMax.COM/Jobs', 'https://www.jobpromax.com/Jobs'],
    ['a port', 'https://jobpromax.com:8443/x', 'https://jobpromax.com:8443/x'],
    ['an &amp; left in a link sent before the M32 fix', 'https://www.jobpromax.com/?utm_source=email&amp;utm_campaign=jpm', 'https://www.jobpromax.com/?utm_source=email&utm_campaign=jpm'],
  ])('redirects %s with a 302 and records nothing', async (_label, url, location) => {
    const res = await clickGet(request(url, 'GET', GONE), ctx(GONE));

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(location);
    expect(mocked.emailEvent.findFirst).not.toHaveBeenCalled();
    expect(mocked.emailEvent.create).not.toHaveBeenCalled();
  });

  it('redirects a protocol-relative link the way the route resolves it, against APP_URL', async () => {
    process.env.APP_URL = 'https://arcreach.example.test';

    const res = await clickGet(request('//www.jobpromax.com/jobs', 'GET', GONE), ctx(GONE));

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://www.jobpromax.com/jobs');
  });

  it('redirects to the url it checked, so a backslash cannot carry the browser to another host', async () => {
    const res = await clickGet(request('https://jobpromax.com\\@evil.test/', 'GET', GONE), ctx(GONE));

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://jobpromax.com/@evil.test/');
  });

  it('answers HEAD the same way, recording nothing', async () => {
    const res = await clickHead(request('https://calendly.com/steve-jpm/30min', 'HEAD', GONE), ctx(GONE));

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://calendly.com/steve-jpm/30min');
    expect(mocked.emailEvent.create).not.toHaveBeenCalled();
  });

  it.each([
    ['a look-alike with the domain as a subdomain', 'https://jobpromax.com.evil.test/'],
    ['a look-alike ending in the domain without a dot', 'https://evil-jobpromax.com/'],
    ['a look-alike with no separator', 'https://notcalendly.com/'],
    ['a look-alike with a Cyrillic letter', 'https://jоbpromax.com/'],
    ['an ideographic full stop', 'https://jobpromax.com。evil.test/'],
    ['another host', 'https://example.com/offer'],
    ['the domain in the path', 'https://evil.test/jobpromax.com'],
    ['the domain in the query', 'https://evil.test/?next=https://jobpromax.com/'],
    ['a javascript: url', 'javascript:alert(1)'],
    ['a javascript: url naming the domain', 'javascript://jobpromax.com/%0Aalert(1)'],
    ['a data: url', 'data:text/html,<script>alert(1)</script>'],
    ['an ftp: url', 'ftp://jobpromax.com/file'],
    ['the domain as the username', 'https://jobpromax.com@evil.test/'],
    ['the domain and an encoded slash as the username', 'https://jobpromax.com%2F@evil.test/'],
    ['credentials on an allowed host', 'https://user:secret@www.jobpromax.com/'],
    ['a username on an allowed host', 'https://evil.test@calendly.com/'],
    ['a leading dot', 'https://.jobpromax.com/'],
    ['a trailing dot', 'https://jobpromax.com./'],
    ['an empty host', 'https://'],
    ['an invalid port', 'https://jobpromax.com:99999/'],
    ['a bracketed name', 'https://[jobpromax.com]/'],
    ['a bare domain with no scheme', 'jobpromax.com'],
    ['a relative link, which resolves to the app', '/pricing'],
    ['an arbitrary value', '1'],
  ])('shows the neutral page and records nothing for %s', async (_label, url) => {
    process.env.APP_URL = 'https://arcreach.example.test';

    const res = await clickGet(request(url, 'GET', GONE), ctx(GONE));

    expectNeutralPage(res);
    expect(await res.text()).toContain('Link Unavailable');
    expect(mocked.emailEvent.create).not.toHaveBeenCalled();
  });

  it('keeps the stored-body check as the only rule while the dispatch exists', async () => {
    storeDispatch();

    expectNeutralPage(await clickGet(request('https://www.jobpromax.com/'), ctx()));
    expectNeutralPage(await clickGet(request('https://calendly.com/someone-else'), ctx()));
    expect(mocked.emailEvent.create).not.toHaveBeenCalled();

    const res = await clickGet(request('https://calendly.com/acme/demo'), ctx());
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('https://calendly.com/acme/demo');
    expect(mocked.emailEvent.create).toHaveBeenCalledWith({
      data: { messageId: 'm-1', eventType: 'click', clickedUrl: 'https://calendly.com/acme/demo' },
    });
  });

  it('still shows the try-again page when the dispatch cannot be looked up', async () => {
    mocked.emailDispatch.findUnique.mockRejectedValue(new Error('db down'));

    expectNeutralPage(await clickGet(request('https://www.jobpromax.com/', 'GET', GONE), ctx(GONE)), 503);
  });
});

describe('the pre-reset link domain check', () => {
  it('allows exactly the domains old mail linked to', () => {
    expect(PRE_RESET_LINK_DOMAINS).toEqual(['jobpromax.com', 'thejobhelpers.com', 'calendly.com']);
  });

  it('accepts only absolute http(s) urls', () => {
    expect(onPreResetLinkDomain('https://www.jobpromax.com/')).toBe(true);
    expect(onPreResetLinkDomain('//www.jobpromax.com/')).toBe(false);
    expect(onPreResetLinkDomain('/jobs')).toBe(false);
    expect(onPreResetLinkDomain('mailto:steve@jobpromax.com')).toBe(false);
  });
});

describe('HEAD requests are never recorded (L6)', () => {
  it('answers a click HEAD with the same redirect but records no click', async () => {
    const res = await clickHead(request('https://calendly.com/acme/demo', 'HEAD'), ctx());

    expect(res.headers.get('location')).toBe('https://calendly.com/acme/demo');
    expect(mocked.emailEvent.findFirst).not.toHaveBeenCalled();
    expect(mocked.emailEvent.create).not.toHaveBeenCalled();
  });

  it('answers an open HEAD with the pixel headers but records no open', async () => {
    const res = await openHead();

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(mocked.emailDispatch.findUnique).not.toHaveBeenCalled();
    expect(mocked.emailEvent.create).not.toHaveBeenCalled();
  });

  it('still records an open on GET', async () => {
    const req = new NextRequest(`http://localhost/api/track/open/${DISPATCH_ID}`, { headers: { 'user-agent': IPHONE_MAIL } });

    const res = await openGet(req, ctx());

    expect(res.headers.get('content-type')).toBe('image/png');
    expect(mocked.emailEvent.create).toHaveBeenCalledWith({ data: { messageId: 'm-1', eventType: 'open' } });
  });
});

describe('automated opens and clicks are kept as machine events, never counted (M34, M35, M36)', () => {
  type EventRow = { id: string; messageId: string; eventType: string; clickedUrl: string | null; botReason?: string; timestamp: Date };
  let events: EventRow[];
  let clock: number;

  /** The subset of Prisma's where the tracking routes use. */
  function matches(row: EventRow, where: Record<string, any>): boolean {
    return Object.entries(where).every(([key, cond]) => {
      const value = (row as any)[key];
      if (cond && typeof cond === 'object') {
        if ('in' in cond) return cond.in.includes(value);
        if ('not' in cond) return value !== cond.not;
        if ('gte' in cond) return value.getTime() >= cond.gte.getTime();
        throw new Error(`Unmodelled condition: ${JSON.stringify(cond)}`);
      }
      return value === cond;
    });
  }

  const LINK_A = 'https://calendly.com/acme/demo';
  const LINK_B = 'https://acme.test/offer?utm_source=email&utm_campaign=q4';
  const SLACKBOT = 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)';

  const openRequest = (userAgent: string | null) =>
    new NextRequest(`http://localhost/api/track/open/${DISPATCH_ID}`, {
      headers: userAgent === null ? {} : { 'user-agent': userAgent },
    });

  beforeEach(() => {
    events = [];
    clock = Date.now();
    mocked.emailEvent.findFirst.mockImplementation(async ({ where }: any) => events.find((e) => matches(e, where)) ?? null);
    mocked.emailEvent.create.mockImplementation(async ({ data }: any) => {
      const row: EventRow = { id: `e-${events.length + 1}`, clickedUrl: null, ...data, timestamp: new Date(clock) };
      events.push(row);
      return { ...row };
    });
    mocked.emailEvent.findMany.mockImplementation(async ({ where }: any) => events.filter((e) => matches(e, where)));
    mocked.emailEvent.updateMany.mockImplementation(async ({ where, data }: any) => {
      const hit = events.filter((e) => matches(e, where));
      hit.forEach((e) => Object.assign(e, data));
      return { count: hit.length };
    });
    mocked.emailEvent.deleteMany.mockImplementation(async ({ where }: any) => {
      const before = events.length;
      events = events.filter((e) => !matches(e, where));
      return { count: before - events.length };
    });
  });

  it('records a Slackbot unfurl hours after the send as a machine click, and still redirects', async () => {
    const res = await clickGet(request(LINK_A, 'GET', DISPATCH_ID, SLACKBOT), ctx());

    expect(res.headers.get('location')).toBe(LINK_A);
    expect(events).toMatchObject([{ eventType: 'machine_click', botReason: 'bot-ua', clickedUrl: LINK_A }]);
  });

  it.each([
    ['no user agent', null],
    ['curl', 'curl/8.4.0'],
    ['python-requests', 'python-requests/2.31.0'],
    ['Googlebot', 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'],
  ])('records a click from %s as a machine click', async (_label, userAgent) => {
    await clickGet(request(LINK_A, 'GET', DISPATCH_ID, userAgent), ctx());

    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('machine_click');
  });

  it('records a browser click 2s after ACS accepted the send as a machine click, although the row was created a minute earlier', async () => {
    storeDispatch(undefined, { sentAt: new Date(Date.now() - 60_000), acceptedAt: new Date(Date.now() - 2_000) });

    await clickGet(request(LINK_A), ctx());

    expect(events).toMatchObject([{ eventType: 'machine_click', botReason: 'prefetch-window' }]);
  });

  it('records a browser click on a dispatch still Sending as a machine click', async () => {
    storeDispatch(TEMPLATE, { status: 'Sending', sentAt: new Date(Date.now() - 60_000), acceptedAt: null });

    await clickGet(request(LINK_A), ctx());

    expect(events).toMatchObject([{ eventType: 'machine_click', botReason: 'prefetch-window' }]);
  });

  it('counts a browser click after the window as a click, and a later machine click of the same link adds its own row', async () => {
    await clickGet(request(LINK_A), ctx());
    await clickGet(request(LINK_A, 'GET', DISPATCH_ID, SLACKBOT), ctx());

    expect(events.map((e) => e.eventType)).toEqual(['click', 'machine_click']);
    expect(events[0]).not.toHaveProperty('botReason');
  });

  it('turns person clicks on two different links within 2s into machine clicks', async () => {
    await clickGet(request(LINK_A), ctx());
    clock += 1_500;
    await clickGet(request(LINK_B), ctx());

    expect(events).toMatchObject([
      { clickedUrl: LINK_A, eventType: 'machine_click', botReason: 'link-burst' },
      { clickedUrl: LINK_B, eventType: 'machine_click', botReason: 'link-burst' },
    ]);
  });

  it('flags a person click that lands within 2s of a scanner clicking another link', async () => {
    await clickGet(request(LINK_A, 'GET', DISPATCH_ID, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Barracuda Sentinel/1.0'), ctx());
    clock += 1_000;
    await clickGet(request(LINK_B), ctx());

    expect(events).toMatchObject([
      { clickedUrl: LINK_A, eventType: 'machine_click', botReason: 'scanner-ua' },
      { clickedUrl: LINK_B, eventType: 'machine_click', botReason: 'link-burst' },
    ]);
  });

  it('keeps at most one click and one machine click row per link however often two links are clicked in turn (H23)', async () => {
    for (let i = 0; i < 50; i++) {
      clock += 500;
      await clickGet(request(i % 2 === 0 ? LINK_A : LINK_B), ctx());
    }

    expect(mocked.emailEvent.create.mock.calls.length).toBeGreaterThan(20);
    const rows = events.map((e) => `${e.clickedUrl} ${e.eventType}`);
    expect(new Set(rows).size).toBe(rows.length);
    for (const link of [LINK_A, LINK_B]) {
      expect(events.filter((e) => e.clickedUrl === link).length).toBeLessThanOrEqual(2);
    }
    expect(events.filter((e) => e.eventType === 'machine_click').map((e) => e.clickedUrl).sort()).toEqual([LINK_A, LINK_B].sort());
  });

  it('removes, rather than converts, a burst click on a link a scanner already clicked', async () => {
    await clickGet(request(LINK_A, 'GET', DISPATCH_ID, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Barracuda Sentinel/1.0'), ctx());
    clock += 10_000;
    await clickGet(request(LINK_A), ctx());
    clock += 1_000;
    await clickGet(request(LINK_B), ctx());

    expect(events).toMatchObject([
      { clickedUrl: LINK_A, eventType: 'machine_click', botReason: 'scanner-ua' },
      { clickedUrl: LINK_B, eventType: 'machine_click', botReason: 'link-burst' },
    ]);
    expect(events).toHaveLength(2);
  });

  it('keeps person clicks on two links 5s apart, and a burst of one link, as clicks', async () => {
    await clickGet(request(LINK_A), ctx());
    clock += 300;
    await clickGet(request(LINK_A), ctx());
    clock += 5_000;
    await clickGet(request(LINK_B), ctx());

    expect(events.map((e) => [e.clickedUrl, e.eventType])).toEqual([
      [LINK_A, 'click'],
      [LINK_B, 'click'],
    ]);
    expect(mocked.emailEvent.updateMany).not.toHaveBeenCalled();
  });

  it('records an Apple Mail Privacy Protection pixel fetch once, as a machine open, and still counts a later real open', async () => {
    await openGet(openRequest('Mozilla/5.0'), ctx());
    await openGet(openRequest('Mozilla/5.0'), ctx());
    await openGet(openRequest(IPHONE_MAIL), ctx());

    expect(events).toMatchObject([
      { eventType: 'machine_open', botReason: 'apple-mpp' },
      { eventType: 'open' },
    ]);
    expect(events).toHaveLength(2);
  });

  it.each([
    ['no user agent', null, 'missing-ua'],
    ['Go', 'Go-http-client/1.1', 'bot-ua'],
  ])('records an open from %s as a machine open', async (_label, userAgent, reason) => {
    await openGet(openRequest(userAgent), ctx());

    expect(events).toMatchObject([{ eventType: 'machine_open', botReason: reason }]);
  });

  it('records a mail client open 5s after ACS accepted the send as a machine open', async () => {
    storeDispatch(undefined, { sentAt: new Date(Date.now() - 60_000), acceptedAt: new Date(Date.now() - 5_000) });

    await openGet(openRequest(IPHONE_MAIL), ctx());

    expect(events).toMatchObject([{ eventType: 'machine_open', botReason: 'prefetch-window' }]);
  });
});

describe("a signed-in app user's hits are never recorded (M37)", () => {
  const USER = { id: 'u-1', name: 'Operator', email: 'op@acme.test', role: 'USER' as const, tokenVersion: 0 };

  const withCookie = (req: NextRequest, cookie: string) =>
    new NextRequest(req.url, { method: req.method, headers: { 'user-agent': CHROME, cookie: `user_session=${cookie}` } });
  const openRequest = (cookie: string) => withCookie(new NextRequest(`http://localhost/api/track/open/${DISPATCH_ID}`), cookie);

  /** A session token shaped like the app's, signed with a key the app does not use. */
  const forgedSession = () =>
    new jose.SignJWT({ ...USER }).setProtectedHeader({ alg: 'HS256' }).setExpirationTime('7d').sign(new TextEncoder().encode('not-the-session-secret-at-all-32-chars'));

  it('serves the pixel but records no open when the operator views a copy of the email', async () => {
    const res = await openGet(openRequest(await signSession(USER)), ctx());

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(mocked.emailDispatch.findUnique).not.toHaveBeenCalled();
    expect(mocked.emailEvent.create).not.toHaveBeenCalled();
  });

  it('redirects the operator to a sent link but records no click', async () => {
    const res = await clickGet(withCookie(request('https://calendly.com/acme/demo'), await signSession(USER)), ctx());

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('https://calendly.com/acme/demo');
    expect(mocked.emailEvent.findFirst).not.toHaveBeenCalled();
    expect(mocked.emailEvent.create).not.toHaveBeenCalled();
  });

  it('still refuses a link the email never sent for the operator', async () => {
    expectNeutralPage(await clickGet(withCookie(request('https://evil.test/'), await signSession(USER)), ctx()));
  });

  it.each([
    ['a forged session cookie', forgedSession],
    ['a malformed session cookie', async () => 'not-a-jwt'],
    ['an empty session cookie', async () => ''],
  ])('records the open and click of a recipient with %s', async (_label, cookie) => {
    const value = await cookie();

    await openGet(openRequest(value), ctx());
    const res = await clickGet(withCookie(request('https://calendly.com/acme/demo'), value), ctx());

    expect(res.headers.get('location')).toBe('https://calendly.com/acme/demo');
    expect(mocked.emailEvent.create).toHaveBeenCalledWith({ data: { messageId: 'm-1', eventType: 'open' } });
    expect(mocked.emailEvent.create).toHaveBeenCalledWith({
      data: { messageId: 'm-1', eventType: 'click', clickedUrl: 'https://calendly.com/acme/demo' },
    });
  });
});

describe('the open pixel never loads the stored body (L10)', () => {
  /** Returns only the fields the query selects, as Prisma does. */
  function storeSelectedDispatch(fields: Record<string, unknown>) {
    const row: Record<string, unknown> = {
      id: DISPATCH_ID,
      messageId: 'm-1',
      status: 'Sent',
      sentAt: new Date(Date.now() - 3600_000),
      acceptedAt: new Date(Date.now() - 3590_000),
      body: applyEmailTracking(TEMPLATE, DISPATCH_ID, true, true, true, 'tok'),
      ...fields,
    };
    mocked.emailDispatch.findUnique.mockImplementation(async ({ select }: any) =>
      select ? Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k]])) : row
    );
  }

  const openRequest = () =>
    new NextRequest(`http://localhost/api/track/open/${DISPATCH_ID}`, { headers: { 'user-agent': IPHONE_MAIL } });

  it('selects only the fields the open needs, and still records it', async () => {
    storeSelectedDispatch({});

    const res = await openGet(openRequest(), ctx());

    expect(res.headers.get('content-type')).toBe('image/png');
    const { select } = mocked.emailDispatch.findUnique.mock.calls[0][0];
    expect(select).toEqual({ messageId: true, status: true, sentAt: true, acceptedAt: true });
    expect(mocked.emailEvent.create).toHaveBeenCalledWith({ data: { messageId: 'm-1', eventType: 'open' } });
  });

  it('still judges the prefetch window from the selected send times', async () => {
    storeSelectedDispatch({ sentAt: new Date(Date.now() - 60_000), acceptedAt: new Date(Date.now() - 5_000) });

    await openGet(openRequest(), ctx());

    expect(mocked.emailEvent.create).toHaveBeenCalledWith({
      data: { messageId: 'm-1', eventType: 'machine_open', botReason: 'prefetch-window' },
    });
  });
});
