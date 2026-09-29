import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';

vi.mock('../../lib/db', () => ({
  prisma: {
    emailDispatch: { findUnique: vi.fn() },
    emailEvent: { findFirst: vi.fn(), create: vi.fn() },
  },
}));

import { prisma } from '../../lib/db';
import { GET as trackClick } from '../../app/api/track/click/[dispatchId]/route';

const mockedPrisma = prisma as any;

/** The referential action the generated client (and so `prisma db push`) applies to a relation. */
function onDelete(model: string, field: string): string | undefined {
  const found = Prisma.dmmf.datamodel.models.find((m) => m.name === model);
  return found?.fields.find((f) => f.name === field)?.relationOnDelete;
}

const TARGET = 'https://example.com/offer';

function makeClick(dispatchId: string): NextRequest {
  return new NextRequest(`http://localhost/api/track/click/${dispatchId}?url=${encodeURIComponent(TARGET)}`, {
    headers: { 'user-agent': 'Mozilla/5.0' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedPrisma.emailEvent.findFirst.mockResolvedValue(null);
  mockedPrisma.emailEvent.create.mockResolvedValue({});
});

describe('deleting a campaign keeps what it sent and received', () => {
  it('unlinks dispatches and replies from a deleted campaign instead of deleting them', () => {
    expect(onDelete('EmailDispatch', 'campaign')).toBe('SetNull');
    expect(onDelete('InboundResponse', 'campaign')).toBe('SetNull');
  });

  it('keeps dispatches when their mailbox is deleted, so send caps and rate limits still count them', () => {
    expect(onDelete('EmailDispatch', 'senderAccount')).toBe('SetNull');
  });

  it('still redirects a click on mail from a deleted campaign, because the dispatch row survives', async () => {
    mockedPrisma.emailDispatch.findUnique.mockResolvedValue({
      id: 'd-1',
      messageId: 'm-1',
      campaignId: null,
      sentAt: new Date(Date.now() - 3600_000),
      body: `<p>See <a href="${TARGET}">our offer</a></p>`,
    });

    const res = await trackClick(makeClick('d-1'), { params: Promise.resolve({ dispatchId: 'd-1' }) });

    expect(res.headers.get('location')).toBe(TARGET);
    expect(mockedPrisma.emailEvent.create).toHaveBeenCalledWith({
      data: { messageId: 'm-1', eventType: 'click', clickedUrl: TARGET },
    });
  });

  it('sends the recipient to the app instead when the dispatch row is gone', async () => {
    mockedPrisma.emailDispatch.findUnique.mockResolvedValue(null);

    const res = await trackClick(makeClick('d-gone'), { params: Promise.resolve({ dispatchId: 'd-gone' }) });

    expect(res.headers.get('location')).not.toBe(TARGET);
    expect(mockedPrisma.emailEvent.create).not.toHaveBeenCalled();
  });
});
