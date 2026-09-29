import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('../../lib/db', () => ({
  prisma: {
    emailDispatch: { findUnique: vi.fn() },
    emailEvent: { findFirst: vi.fn(), create: vi.fn() },
  },
}));

import { prisma } from '../../lib/db';
import { GET as clickGet, HEAD as clickHead } from '../../app/api/track/click/[dispatchId]/route';
import { GET as openGet, HEAD as openHead } from '../../app/api/track/open/[dispatchId]/route';
import { applyEmailTracking } from '../../lib/emailTracking';

const mocked = prisma as any;

const DISPATCH_ID = 'd-1';
const TEMPLATE =
  '<p>Book at <a href="https://calendly.com/acme/demo">Calendly</a>, ' +
  'read <a href="https://acme.test/offer?utm_source=email&amp;utm_campaign=q4">the offer</a>, ' +
  'see <a href="/pricing">pricing</a> or <a href="javascript:alert(1)">this</a>.</p>';

/** The dispatch as the send engine stores it: the final tracked body. */
function storeDispatch(body: string | null = applyEmailTracking(TEMPLATE, DISPATCH_ID, true, true, true, 'tok')) {
  mocked.emailDispatch.findUnique.mockResolvedValue({
    id: DISPATCH_ID,
    messageId: 'm-1',
    sentAt: new Date(Date.now() - 3600_000),
    body,
  });
}

function request(url: string | null, method = 'GET', dispatchId = DISPATCH_ID): NextRequest {
  const query = url === null ? '' : `?url=${encodeURIComponent(url)}`;
  return new NextRequest(`http://localhost/api/track/click/${dispatchId}${query}`, {
    method,
    headers: { 'user-agent': 'Mozilla/5.0' },
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
  mocked.emailEvent.create.mockResolvedValue({});
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

    const res = await clickGet(request('https://calendly.com/acme/demo', 'GET', 'd-gone'), ctx('d-gone'));

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
    const req = new NextRequest(`http://localhost/api/track/open/${DISPATCH_ID}`, { headers: { 'user-agent': 'Mozilla/5.0' } });

    const res = await openGet(req, ctx());

    expect(res.headers.get('content-type')).toBe('image/png');
    expect(mocked.emailEvent.create).toHaveBeenCalledWith({ data: { messageId: 'm-1', eventType: 'open' } });
  });
});
