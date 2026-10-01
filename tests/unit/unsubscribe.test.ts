import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('../../lib/db', () => ({
  prisma: {
    lead: { findUnique: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() },
    leadAlias: { findUnique: vi.fn() },
    deletedLead: { findUnique: vi.fn() },
    campaignEnrollment: { updateMany: vi.fn() },
    suppressedEmail: { createMany: vi.fn() },
    emailDispatch: { findUnique: vi.fn(), findFirst: vi.fn() },
    emailEvent: { create: vi.fn() },
  },
}));

import { prisma } from '../../lib/db';
import { GET, POST } from '../../app/api/unsubscribe/route';
import { signUnsubscribeToken } from '../../lib/unsubscribeLink';

const mocked = prisma as any;

function makeReq(query: string, init?: { method: string; body?: string; headers?: Record<string, string> }): NextRequest {
  return new NextRequest(`http://localhost/api/unsubscribe${query}`, init);
}

const post = (query: string) => POST(makeReq(query, { method: 'POST' }));

/** The write that marks a lead Unsubscribed, only if it is not already. */
const statusChange = (id: string) => ({ where: { id, status: { not: 'Unsubscribed' } }, data: { status: 'Unsubscribed' } });

/** What an unsubscribe writes: nothing at all when `wrote` is false. */
function expectUnsubscribed(wrote: boolean) {
  const expectWrite = (mock: any) => (wrote ? expect(mock).toHaveBeenCalled() : expect(mock).not.toHaveBeenCalled());
  expectWrite(mocked.suppressedEmail.createMany);
  expectWrite(mocked.lead.updateMany);
  expectWrite(mocked.campaignEnrollment.updateMany);
}

describe('unsubscribe page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.suppressedEmail.createMany.mockResolvedValue({ count: 1 });
    mocked.lead.updateMany.mockResolvedValue({ count: 1 });
  });

  it('HTML-escapes the lead email so stored markup cannot run (M49)', async () => {
    mocked.lead.findUnique.mockResolvedValue({
      id: 'lead-1',
      email: '<img src=x onerror="alert(1)">@example.com',
      status: 'Active',
    });

    const res = await post('?id=lead-1');
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(html).not.toContain('<img');
    expect(html).toContain('<strong>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;@example.com</strong> has been removed');
    expect(mocked.lead.updateMany).toHaveBeenCalledWith(statusChange('lead-1'));
  });

  it('sends a restrictive Content-Security-Policy with the HTML page, allowing its form to post only back here', async () => {
    mocked.lead.findUnique.mockResolvedValue({ id: 'lead-1', email: 'jane@example.com', status: 'Unsubscribed' });

    for (const res of [await GET(makeReq('?id=lead-1')), await post('?id=lead-1')]) {
      const csp = res.headers.get('content-security-policy') || '';
      expect(res.headers.get('content-type')).toContain('text/html');
      expect(csp).toContain("default-src 'none'");
      expect(csp).not.toMatch(/script-src/);
      expect(csp).toContain("form-action 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
    }
    expect(mocked.lead.updateMany).not.toHaveBeenCalled();
  });

  it('sets the same CSP on error pages', async () => {
    const missing = await GET(makeReq(''));
    expect(missing.status).toBe(400);
    expect(missing.headers.get('content-security-policy')).toContain("default-src 'none'");

    mocked.lead.findUnique.mockResolvedValue(null);
    mocked.leadAlias.findUnique.mockResolvedValue(null);
    mocked.deletedLead.findUnique.mockResolvedValue(null);
    const notFound = await post('?id=nope');
    expect(notFound.status).toBe(404);
    expect(notFound.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(mocked.suppressedEmail.createMany).not.toHaveBeenCalled();
  });

  it('unsubscribes the kept lead when the link carries the id of a lead merged into it (H31)', async () => {
    mocked.lead.findUnique.mockResolvedValue(null);
    mocked.leadAlias.findUnique.mockResolvedValue({ lead: { id: 'lead-kept', email: 'jane@example.com', status: 'Neutral' } });

    const res = await post('?id=lead-merged');
    expect(res.status).toBe(200);
    expect(mocked.leadAlias.findUnique).toHaveBeenCalledWith({ where: { id: 'lead-merged' }, select: { lead: true } });
    expect(mocked.lead.updateMany).toHaveBeenCalledWith(statusChange('lead-kept'));
    expect(mocked.campaignEnrollment.updateMany).toHaveBeenCalledWith({
      where: { leadId: 'lead-kept', status: 'Active' },
      data: { status: 'Paused', nextActionDate: null },
    });
  });

  it.each([
    ['a subscribed lead', 'Neutral'],
    ['a lead already Unsubscribed before the suppression list existed', 'Unsubscribed'],
  ])('puts the normalised address of %s on the suppression list (H18)', async (_label, status) => {
    mocked.lead.findUnique.mockResolvedValue({ id: 'lead-1', email: ' Jane@Example.com', status });

    const res = await post('?id=lead-1');
    expect(res.status).toBe(200);
    expect(mocked.suppressedEmail.createMany).toHaveBeenCalledWith({
      data: [{ email: 'jane@example.com', reason: 'Unsubscribed', source: 'unsubscribe-link' }],
      skipDuplicates: true,
    });
  });

  it('suppresses the address of a deleted lead whose link is clicked, with no lead left to update (H18)', async () => {
    mocked.lead.findUnique.mockResolvedValue(null);
    mocked.leadAlias.findUnique.mockResolvedValue(null);
    mocked.deletedLead.findUnique.mockResolvedValue({ id: 'lead-gone', email: 'jane@example.com' });
    mocked.lead.findFirst.mockResolvedValue(null);

    const res = await post('?id=lead-gone');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<strong>jane@example.com</strong> has been removed');
    expect(mocked.lead.findFirst).toHaveBeenCalledWith({ where: { email: { in: ['jane@example.com'], mode: 'insensitive' } } });
    expect(mocked.suppressedEmail.createMany).toHaveBeenCalledWith({
      data: [{ email: 'jane@example.com', reason: 'Unsubscribed', source: 'unsubscribe-link' }],
      skipDuplicates: true,
    });
    expect(mocked.lead.updateMany).not.toHaveBeenCalled();
    expect(mocked.campaignEnrollment.updateMany).not.toHaveBeenCalled();
  });
});

describe('two-step unsubscribe with signed links (H16)', () => {
  const token = signUnsubscribeToken('lead-1', 'dispatch-1');

  beforeEach(() => {
    vi.clearAllMocks();
    mocked.suppressedEmail.createMany.mockResolvedValue({ count: 1 });
    mocked.lead.updateMany.mockResolvedValue({ count: 1 });
    mocked.lead.findUnique.mockResolvedValue({ id: 'lead-1', email: 'jane@example.com', status: 'Neutral' });
  });

  it('GET only shows a confirmation page whose button posts the same link back, so link scanners unsubscribe no one', async () => {
    const res = await GET(makeReq(`?token=${token}`));

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<h1>Confirm Unsubscribe</h1>');
    expect(html).toContain('<strong>jane@example.com</strong> will stop receiving our emails once you confirm below.');
    expect(html).toContain(`<form method="post" action="/api/unsubscribe?token=${token}"><button type="submit">Unsubscribe</button></form>`);
    expect(mocked.lead.findUnique).toHaveBeenCalledWith({ where: { id: 'lead-1' } });
    expectUnsubscribed(false);
  });

  it('GET of a link sent before tokens, carrying the raw lead id, still reaches the confirmation page', async () => {
    const res = await GET(makeReq('?id=lead-1'));

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<form method="post" action="/api/unsubscribe?id=lead-1">');
    expectUnsubscribed(false);
  });

  it('POST from the confirmation button unsubscribes the lead the token was signed for', async () => {
    const res = await post(`?token=${token}`);

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<strong>jane@example.com</strong> has been removed');
    expect(mocked.suppressedEmail.createMany).toHaveBeenCalledWith({
      data: [{ email: 'jane@example.com', reason: 'Unsubscribed', source: 'unsubscribe-link' }],
      skipDuplicates: true,
    });
    expect(mocked.lead.updateMany).toHaveBeenCalledWith(statusChange('lead-1'));
    expect(mocked.campaignEnrollment.updateMany).toHaveBeenCalledWith({
      where: { leadId: 'lead-1', status: 'Active' },
      data: { status: 'Paused', nextActionDate: null },
    });
  });

  it('accepts an RFC 8058 one-click POST from a mail client', async () => {
    const res = await POST(makeReq(`?token=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
    }));

    expect(res.status).toBe(200);
    expectUnsubscribed(true);
  });

  it.each([
    ['a tampered token', `${Buffer.from('lead-2').toString('base64url')}${token.slice(token.indexOf('.'))}`],
    ['a truncated token', token.slice(0, -4)],
    ['a raw lead id as the token', 'lead-1'],
  ])('refuses %s on GET and POST without looking up or unsubscribing anyone', async (_label, bad) => {
    for (const res of [await GET(makeReq(`?token=${encodeURIComponent(bad)}`)), await post(`?token=${encodeURIComponent(bad)}`)]) {
      expect(res.status).toBe(400);
      expect(await res.text()).toContain('Invalid Link');
    }
    expect(mocked.lead.findUnique).not.toHaveBeenCalled();
    expectUnsubscribed(false);
  });
});

describe('the unsubscribe is recorded on the email it came from (M31)', () => {
  const token = signUnsubscribeToken('lead-1', 'dispatch-1');

  beforeEach(() => {
    vi.clearAllMocks();
    mocked.suppressedEmail.createMany.mockResolvedValue({ count: 1 });
    mocked.lead.updateMany.mockResolvedValue({ count: 1 });
    mocked.lead.findUnique.mockResolvedValue({ id: 'lead-1', email: 'jane@example.com', status: 'Neutral' });
    mocked.emailDispatch.findUnique.mockResolvedValue({ messageId: 'msg-signed' });
    mocked.emailDispatch.findFirst.mockResolvedValue({ messageId: 'msg-latest' });
    mocked.emailEvent.create.mockResolvedValue({});
  });

  it('records an unsubscribe event on the dispatch a signed link names', async () => {
    const res = await post(`?token=${token}`);

    expect(res.status).toBe(200);
    expect(mocked.emailDispatch.findUnique).toHaveBeenCalledWith({ where: { id: 'dispatch-1' }, select: { messageId: true } });
    expect(mocked.emailEvent.create).toHaveBeenCalledWith({ data: { messageId: 'msg-signed', eventType: 'unsubscribe' } });
  });

  it("records a link sent before tokens on the lead's latest campaign email", async () => {
    const res = await post('?id=lead-1');

    expect(res.status).toBe(200);
    expect(mocked.emailDispatch.findFirst).toHaveBeenCalledWith({
      where: { leadId: 'lead-1', status: 'Sent', stepOrder: { not: null } },
      orderBy: { sentAt: 'desc' },
      select: { messageId: true },
    });
    expect(mocked.emailEvent.create).toHaveBeenCalledWith({ data: { messageId: 'msg-latest', eventType: 'unsubscribe' } });
  });

  it.each([
    ['the lead was already Unsubscribed', () => mocked.lead.findUnique.mockResolvedValue({ id: 'lead-1', email: 'jane@example.com', status: 'Unsubscribed' })],
    ['the email it came from no longer exists', () => mocked.emailDispatch.findUnique.mockResolvedValue(null)],
  ])('records nothing when %s', async (_label, arrange) => {
    arrange();

    const res = await post(`?token=${token}`);

    expect(res.status).toBe(200);
    expect(mocked.emailEvent.create).not.toHaveBeenCalled();
  });

  it('still unsubscribes the lead when the event cannot be recorded', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocked.emailEvent.create.mockRejectedValue(new Error('database unavailable'));

    const res = await post(`?token=${token}`);

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('has been removed');
    expect(mocked.lead.updateMany).toHaveBeenCalledWith(statusChange('lead-1'));
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

describe('an unsubscribe is counted once, when the lead becomes Unsubscribed (stats A6)', () => {
  const token = signUnsubscribeToken('lead-1', 'dispatch-1');
  const oneClick = () => POST(makeReq(`?token=${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'List-Unsubscribe=One-Click',
  }));

  /**
   * A lead row the route reads and marks Unsubscribed as Postgres would: the
   * status condition of the write is checked against the row as it is then.
   */
  function storedLead(status: string) {
    const row = { id: 'lead-1', email: 'jane@example.com', status };
    mocked.lead.findUnique.mockImplementation(async () => ({ ...row }));
    mocked.lead.updateMany.mockImplementation(async ({ where, data }: any) => {
      if (where.id !== row.id || row.status === where.status.not) return { count: 0 };
      row.status = data.status;
      return { count: 1 };
    });
    return row;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocked.emailDispatch.findUnique.mockResolvedValue({ messageId: 'msg-signed' });
    mocked.emailEvent.create.mockResolvedValue({});
  });

  it('counts the opt-out of an address already on the suppression list for a hard bounce, which is not added again', async () => {
    mocked.suppressedEmail.createMany.mockResolvedValue({ count: 0 });
    const lead = storedLead('Bounced');

    const res = await post(`?token=${token}`);

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<strong>jane@example.com</strong> has been removed');
    expect(mocked.suppressedEmail.createMany).toHaveBeenCalledWith({
      data: [{ email: 'jane@example.com', reason: 'Unsubscribed', source: 'unsubscribe-link' }],
      skipDuplicates: true,
    });
    expect(mocked.lead.updateMany).toHaveBeenCalledWith(statusChange('lead-1'));
    expect(lead.status).toBe('Unsubscribed');
    expect(mocked.campaignEnrollment.updateMany).toHaveBeenCalledWith({
      where: { leadId: 'lead-1', status: 'Active' },
      data: { status: 'Paused', nextActionDate: null },
    });
    expect(mocked.emailEvent.create).toHaveBeenCalledTimes(1);
    expect(mocked.emailEvent.create).toHaveBeenCalledWith({ data: { messageId: 'msg-signed', eventType: 'unsubscribe' } });
  });

  it.each([
    ['a new address', 'Neutral', () => mocked.suppressedEmail.createMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValue({ count: 0 })],
    ['an address already listed for a hard bounce', 'Bounced', () => mocked.suppressedEmail.createMany.mockResolvedValue({ count: 0 })],
  ])('counts %s once when the button and then a one-click POST both unsubscribe', async (_label, status, arrangeList) => {
    arrangeList();
    storedLead(status);

    for (const res of [await post(`?token=${token}`), await oneClick(), await post(`?token=${token}`)]) {
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('has been removed');
    }

    expect(mocked.suppressedEmail.createMany).toHaveBeenCalledTimes(3);
    expect(mocked.lead.updateMany).toHaveBeenCalledTimes(1);
    expect(mocked.emailEvent.create).toHaveBeenCalledTimes(1);
  });

  it('counts the button and a one-click POST racing it once, though both read the lead before either changed it', async () => {
    mocked.suppressedEmail.createMany.mockResolvedValue({ count: 0 });
    const lead = storedLead('Neutral');
    mocked.lead.findUnique.mockResolvedValue({ id: 'lead-1', email: 'jane@example.com', status: 'Neutral' });

    const responses = await Promise.all([post(`?token=${token}`), oneClick()]);

    expect(responses.map((res) => res.status)).toEqual([200, 200]);
    expect(mocked.lead.updateMany).toHaveBeenCalledTimes(2);
    expect(lead.status).toBe('Unsubscribed');
    expect(mocked.emailEvent.create).toHaveBeenCalledTimes(1);
  });
});
