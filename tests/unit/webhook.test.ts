import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('../../lib/db', () => ({
  prisma: {
    emailDispatch: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
    lead: { update: vi.fn() },
    campaignEnrollment: { updateMany: vi.fn() },
    emailEvent: { create: vi.fn() },
  },
}));

import { prisma } from '../../lib/db';
import { POST } from '../../app/api/webhook/route';

function makeReq(body: any, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost/api/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('webhook POST auth', () => {
  const ORIG_SECRET = process.env.WEBHOOK_SECRET;

  beforeEach(() => {
    process.env.WEBHOOK_SECRET = 'test-secret-value';
  });
  afterEach(() => {
    if (ORIG_SECRET === undefined) delete process.env.WEBHOOK_SECRET;
    else process.env.WEBHOOK_SECRET = ORIG_SECRET;
  });

  it('returns 500 when WEBHOOK_SECRET is not configured', async () => {
    delete process.env.WEBHOOK_SECRET;
    const res = await POST(makeReq([], { 'x-arcreach-webhook-secret': 'anything' }));
    expect(res.status).toBe(500);
  });

  it('returns 401 when the secret header is missing', async () => {
    const res = await POST(makeReq([]));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/header missing/i);
  });

  it('returns 401 when the secret header is wrong', async () => {
    const res = await POST(makeReq([], { 'x-arcreach-webhook-secret': 'wrong' }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/invalid/i);
  });

  it('returns 401 even when the wrong secret is the same length (timing-safe path)', async () => {
    const res = await POST(
      makeReq([], { 'x-arcreach-webhook-secret': 'test-secret-XXXXX' })
    );
    expect(res.status).toBe(401);
  });

  it('passes auth and echoes the EventGrid validation code on the handshake', async () => {
    const event = {
      eventType: 'Microsoft.EventGrid.SubscriptionValidationEvent',
      data: { validationCode: 'abc-123' },
    };
    const res = await POST(
      makeReq([event], { 'x-arcreach-webhook-secret': 'test-secret-value' })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.validationResponse).toBe('abc-123');
  });
});

describe('webhook delivery report for a mailbox test send (L3)', () => {
  const ORIG_SECRET = process.env.WEBHOOK_SECRET;
  const mockedPrisma = prisma as any;

  const failedReport = (messageId: string) => POST(makeReq(
    [{ eventType: 'Microsoft.Communication.EmailDeliveryReportReceived', data: { messageId, status: 'Failed' } }],
    { 'x-arcreach-webhook-secret': 'test-secret-value' },
  ));

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    process.env.WEBHOOK_SECRET = 'test-secret-value';
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (ORIG_SECRET === undefined) delete process.env.WEBHOOK_SECRET;
    else process.env.WEBHOOK_SECRET = ORIG_SECRET;
  });

  it('records the bounce without touching any lead when the dispatch has none', async () => {
    mockedPrisma.emailDispatch.findUnique.mockResolvedValue({ id: 'd-test', messageId: 'op-test', leadId: null });

    const res = await failedReport('op-test');
    expect(res.status).toBe(200);
    expect(mockedPrisma.lead.update).not.toHaveBeenCalled();
    expect(mockedPrisma.campaignEnrollment.updateMany).not.toHaveBeenCalled();
    expect(mockedPrisma.emailEvent.create).toHaveBeenCalledWith({ data: { messageId: 'op-test', eventType: 'bounce' } });
  });

  it('still marks the lead and its enrollments Bounced for a dispatch to a lead', async () => {
    mockedPrisma.emailDispatch.findUnique.mockResolvedValue({ id: 'd-1', messageId: 'op-1', leadId: 'lead-1' });

    expect((await failedReport('op-1')).status).toBe(200);
    expect(mockedPrisma.lead.update).toHaveBeenCalledWith({
      where: { id: 'lead-1' }, data: { status: 'Bounced', validationStatus: 'Invalid' },
    });
    expect(mockedPrisma.campaignEnrollment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { leadId: 'lead-1', status: 'Active' } }),
    );
    expect(mockedPrisma.emailEvent.create).toHaveBeenCalledTimes(1);
  });
});
