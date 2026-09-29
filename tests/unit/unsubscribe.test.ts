import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('../../lib/db', () => ({
  prisma: {
    lead: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
    leadAlias: { findUnique: vi.fn() },
    deletedLead: { findUnique: vi.fn() },
    campaignEnrollment: { updateMany: vi.fn() },
    suppressedEmail: { createMany: vi.fn() },
  },
}));

import { prisma } from '../../lib/db';
import { GET } from '../../app/api/unsubscribe/route';

const mocked = prisma as any;

function makeReq(query: string): NextRequest {
  return new NextRequest(`http://localhost/api/unsubscribe${query}`);
}

describe('unsubscribe GET page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.suppressedEmail.createMany.mockResolvedValue({ count: 1 });
  });

  it('HTML-escapes the lead email so stored markup cannot run (M49)', async () => {
    mocked.lead.findUnique.mockResolvedValue({
      id: 'lead-1',
      email: '<img src=x onerror="alert(1)">@example.com',
      status: 'Active',
    });

    const res = await GET(makeReq('?id=lead-1'));
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(html).not.toContain('<img');
    expect(html).toContain('<strong>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;@example.com</strong> has been removed');
    expect(mocked.lead.update).toHaveBeenCalledWith({ where: { id: 'lead-1' }, data: { status: 'Unsubscribed' } });
  });

  it('sends a restrictive Content-Security-Policy with the HTML page', async () => {
    mocked.lead.findUnique.mockResolvedValue({ id: 'lead-1', email: 'jane@example.com', status: 'Unsubscribed' });

    const res = await GET(makeReq('?id=lead-1'));
    const csp = res.headers.get('content-security-policy') || '';
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toMatch(/script-src/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(mocked.lead.update).not.toHaveBeenCalled();
  });

  it('sets the same CSP on error pages', async () => {
    const missing = await GET(makeReq(''));
    expect(missing.status).toBe(400);
    expect(missing.headers.get('content-security-policy')).toContain("default-src 'none'");

    mocked.lead.findUnique.mockResolvedValue(null);
    mocked.leadAlias.findUnique.mockResolvedValue(null);
    mocked.deletedLead.findUnique.mockResolvedValue(null);
    const notFound = await GET(makeReq('?id=nope'));
    expect(notFound.status).toBe(404);
    expect(notFound.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(mocked.suppressedEmail.createMany).not.toHaveBeenCalled();
  });

  it('unsubscribes the kept lead when the link carries the id of a lead merged into it (H31)', async () => {
    mocked.lead.findUnique.mockResolvedValue(null);
    mocked.leadAlias.findUnique.mockResolvedValue({ lead: { id: 'lead-kept', email: 'jane@example.com', status: 'Neutral' } });

    const res = await GET(makeReq('?id=lead-merged'));
    expect(res.status).toBe(200);
    expect(mocked.leadAlias.findUnique).toHaveBeenCalledWith({ where: { id: 'lead-merged' }, select: { lead: true } });
    expect(mocked.lead.update).toHaveBeenCalledWith({ where: { id: 'lead-kept' }, data: { status: 'Unsubscribed' } });
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

    const res = await GET(makeReq('?id=lead-1'));
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

    const res = await GET(makeReq('?id=lead-gone'));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<strong>jane@example.com</strong> has been removed');
    expect(mocked.lead.findFirst).toHaveBeenCalledWith({ where: { email: { in: ['jane@example.com'], mode: 'insensitive' } } });
    expect(mocked.suppressedEmail.createMany).toHaveBeenCalledWith({
      data: [{ email: 'jane@example.com', reason: 'Unsubscribed', source: 'unsubscribe-link' }],
      skipDuplicates: true,
    });
    expect(mocked.lead.update).not.toHaveBeenCalled();
    expect(mocked.campaignEnrollment.updateMany).not.toHaveBeenCalled();
  });
});
