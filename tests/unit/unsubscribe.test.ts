import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('../../lib/db', () => ({
  prisma: {
    lead: { findUnique: vi.fn(), update: vi.fn() },
    campaignEnrollment: { updateMany: vi.fn() },
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
    const notFound = await GET(makeReq('?id=nope'));
    expect(notFound.status).toBe(404);
    expect(notFound.headers.get('content-security-policy')).toContain("default-src 'none'");
  });
});
