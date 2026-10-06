import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('../../lib/db', () => ({
  prisma: {
    senderAccount: { findUnique: vi.fn(), updateMany: vi.fn() },
    inboundResponse: { findFirst: vi.fn() },
    lead: { findUnique: vi.fn() },
    globalSettings: { findUnique: vi.fn(), findFirst: vi.fn() },
    emailDispatch: { create: vi.fn(), count: vi.fn() },
    suppressedEmail: { findMany: vi.fn() },
  },
}));

vi.mock('../../lib/session', () => ({
  getSession: vi.fn(),
}));

vi.mock('../../lib/emailProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/emailProvider')>()),
  sendMessage: vi.fn(),
}));

import { prisma } from '../../lib/db';
import { getSession } from '../../lib/session';
import { sendMessage, EmailSendError } from '../../lib/emailProvider';
import { senderCapReachedReason, senderCapDispatchWhere } from '../../lib/sendEngine';
import { POST as postUniboxReply } from '../../app/api/unibox/reply/route';
import { POST as postTestEmail } from '../../app/api/send-email/test/route';

const mockedPrisma = prisma as any;
const mockedSession = vi.mocked(getSession);
const mockedSend = vi.mocked(sendMessage);

const ADMIN = { id: 'admin-1', name: 'Admin', email: 'admin@example.com', role: 'ADMIN' as const };

const AZURE_SETTINGS = {
  id: 'global', activeProvider: 'AZURE', azureConnString: 'enc:v1:conn', azureSenderDomains: ['acme.test'],
  rateLimitMinute: 10, rateLimitHour: 100,
};

const NOW = new Date('2026-09-20T12:00:00Z');

/** Warmup on since this morning (Day 1): capped at warmupLimit, 50, well under its daily limit. */
const WARMING = {
  id: 'mb-1', userId: 'admin-1', emailAddress: 'one@acme.test', name: 'One', provider: 'Google Workspace', replyTo: null,
  warmupEnabled: true, warmupStartedAt: new Date('2026-09-20T08:00:00Z'), dailyLimit: 500, warmupLimit: 50, warmupRamp: 2,
};

/** Warmup off: capped at its daily limit, 100. */
const STEADY = { ...WARMING, warmupEnabled: false, warmupStartedAt: null, dailyLimit: 100 };

/** Counted sends per mailbox in the last 24 hours, and all dispatches in the rate-limit windows. */
let mailboxSent: Record<string, number>;
let globalSent: number;

function makeReq(path: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const reply = () => postUniboxReply(makeReq('/api/unibox/reply', {
  responseId: 'in-1', body: 'Thanks!', senderAccountId: 'mb-1',
}));
const test = () => postTestEmail(makeReq('/api/send-email/test', { senderAccountId: 'mb-1' }));

function useMailbox(mailbox: Record<string, unknown>) {
  mockedPrisma.senderAccount.findUnique.mockResolvedValue(mailbox);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  mailboxSent = {};
  globalSent = 0;
  mockedSession.mockResolvedValue(ADMIN);
  mockedSend.mockResolvedValue({ providerMessageId: 'provider-msg-1' });
  mockedPrisma.globalSettings.findUnique.mockResolvedValue(AZURE_SETTINGS);
  mockedPrisma.lead.findUnique.mockResolvedValue({ id: 'lead-1', email: 'lead@prospect.test', name: 'Lead' });
  mockedPrisma.inboundResponse.findFirst.mockResolvedValue({ leadId: 'lead-1', campaignId: 'cmp-1', subject: 'Hello', messageId: null, references: null, lead: { email: 'lead@prospect.test' } });
  mockedPrisma.emailDispatch.create.mockImplementation(async ({ data }: any) => ({ id: 'dispatch-1', ...data }));
  mockedPrisma.emailDispatch.count.mockImplementation(async ({ where }: any) =>
    where.senderAccountId ? (mailboxSent[where.senderAccountId] ?? 0) : globalSent,
  );
  mockedPrisma.senderAccount.updateMany.mockResolvedValue({ count: 1 });
  mockedPrisma.suppressedEmail.findMany.mockResolvedValue([]);
  useMailbox(WARMING);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('senderCapReachedReason (L2)', () => {
  it('counts the mailbox\'s sends exactly as the engine does and allows a send under its cap', async () => {
    mailboxSent['mb-1'] = 49;

    expect(await senderCapReachedReason(WARMING, NOW)).toBeNull();
    expect(mockedPrisma.emailDispatch.count).toHaveBeenCalledWith({ where: senderCapDispatchWhere('mb-1', NOW) });
  });

  it('names the warmup cap while the ramp holds the mailbox below its daily limit', async () => {
    mailboxSent['mb-1'] = 50;

    expect(await senderCapReachedReason(WARMING, NOW)).toBe(
      'one@acme.test has reached its warmup cap of 50 emails in the last 24 hours. Nothing was sent; it can send again as those sends pass 24 hours old.',
    );
  });

  it('names the daily cap when warmup is off', async () => {
    mailboxSent['mb-1'] = 100;

    expect(await senderCapReachedReason(STEADY, NOW)).toMatch(/^one@acme\.test has reached its daily cap of 100 emails/);
  });

  it('reads global limits of null or 0 as none set, so the daily cap still applies', async () => {
    mailboxSent['mb-1'] = 100;

    expect(await senderCapReachedReason(STEADY, NOW, { minute: null, hour: 0 })).toMatch(/has reached its daily cap of 100 emails/);
  });
});

describe('senderCapReachedReason while a global rate limit has the daily limits off', () => {
  const GLOBAL = { minute: 10, hour: 100 };

  it('allows a send from a mailbox past its daily limit, without counting its sends', async () => {
    mailboxSent['mb-1'] = 5000;

    expect(await senderCapReachedReason(STEADY, NOW, GLOBAL)).toBeNull();
    expect(mockedPrisma.emailDispatch.count).not.toHaveBeenCalled();
  });

  it('still holds a warming mailbox to its ramp', async () => {
    mailboxSent['mb-1'] = 49;
    expect(await senderCapReachedReason(WARMING, NOW, GLOBAL)).toBeNull();

    mailboxSent['mb-1'] = 50;
    expect(await senderCapReachedReason(WARMING, NOW, GLOBAL)).toMatch(/^one@acme\.test has reached its warmup cap of 50 emails/);
  });

  it('lets the ramp run past the daily limit, which no longer clamps it', async () => {
    // Day 1 of a ramp that starts at 50, on a mailbox whose daily limit is 20.
    const lowLimit = { ...WARMING, dailyLimit: 20 };
    mailboxSent['mb-1'] = 20;

    expect(await senderCapReachedReason(lowLimit, NOW)).toMatch(/has reached its daily cap of 20 emails/);
    expect(await senderCapReachedReason(lowLimit, NOW, GLOBAL)).toBeNull();
  });
});

describe('POST /api/unibox/reply caps (L2)', () => {
  it('refuses a reply from a warming mailbox already at its ramp cap, sending and recording nothing', async () => {
    mailboxSent['mb-1'] = 50;

    const res = await reply();
    expect(res.status).toBe(429);
    expect((await res.json()).error).toMatch(/has reached its warmup cap of 50 emails in the last 24 hours/);
    expect(mockedSend).not.toHaveBeenCalled();
    expect(mockedPrisma.emailDispatch.create).not.toHaveBeenCalled();
    expect(mockedPrisma.senderAccount.updateMany).not.toHaveBeenCalled();
  });

  it('refuses a reply once the global rate limit is reached', async () => {
    globalSent = 10;

    const res = await reply();
    expect(res.status).toBe(429);
    expect((await res.json()).error).toMatch(/^Global outbound rate limit reached: Max 10 emails per minute/);
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it('records the reply on the mailbox and counts it toward the warmup ramp', async () => {
    mailboxSent['mb-1'] = 49;

    const res = await reply();
    expect(res.status).toBe(200);
    expect(mockedSend).toHaveBeenCalledTimes(1);
    expect(mockedPrisma.emailDispatch.create.mock.calls[0][0].data).toMatchObject({
      leadId: 'lead-1', senderAccountId: 'mb-1', campaignId: 'cmp-1', status: 'Sent',
    });
    expect(mockedPrisma.senderAccount.updateMany).toHaveBeenCalledWith({
      where: { id: 'mb-1' }, data: { warmupSent: { increment: 1 } },
    });
  });

  it('leaves warmupSent alone for a mailbox that is not warming up', async () => {
    useMailbox(STEADY);

    expect((await reply()).status).toBe(200);
    expect(mockedPrisma.emailDispatch.create).toHaveBeenCalledTimes(1);
    expect(mockedPrisma.senderAccount.updateMany).not.toHaveBeenCalled();
  });
});

describe('POST /api/send-email/test limits and wording (L2, L3)', () => {
  it('sends a plain-text subject with no emoji and a body naming Azure Communication Services', async () => {
    expect((await test()).status).toBe(200);

    const { subject, body } = mockedSend.mock.calls[0][0];
    expect(subject).toBe('ArcReach Test: one@acme.test is connected');
    expect(subject).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(body).toContain('Provider: Azure Communication Services');
    expect(body).toContain('If you received this email, Azure Communication Services can send from this sender account as expected.');
    expect(body).not.toMatch(/SMTP|Google Workspace/);
  });

  it('records the test as a Sent dispatch from the mailbox with no lead or campaign, and counts it toward the ramp', async () => {
    expect((await test()).status).toBe(200);

    expect(mockedPrisma.emailDispatch.create).toHaveBeenCalledTimes(1);
    const { data } = mockedPrisma.emailDispatch.create.mock.calls[0][0];
    expect(data).toMatchObject({
      senderAccountId: 'mb-1',
      messageId: 'provider-msg-1',
      subject: 'ArcReach Test: one@acme.test is connected',
      status: 'Sent',
    });
    expect(data.leadId).toBeUndefined();
    expect(data.campaignId).toBeUndefined();
    expect(mockedPrisma.senderAccount.updateMany).toHaveBeenCalledWith({
      where: { id: 'mb-1' }, data: { warmupSent: { increment: 1 } },
    });
  });

  it('refuses the test once the global rate limit is reached, sending and recording nothing', async () => {
    mockedPrisma.globalSettings.findUnique.mockResolvedValue({ ...AZURE_SETTINGS, rateLimitMinute: null });
    globalSent = 100;

    const res = await test();
    const data = await res.json();
    expect(res.status).toBe(429);
    expect(data.success).toBe(false);
    expect(data.error).toMatch(/^Global outbound rate limit reached: Max 100 emails per hour/);
    expect(mockedSend).not.toHaveBeenCalled();
    expect(mockedPrisma.emailDispatch.create).not.toHaveBeenCalled();
  });

  it('sends the test from a mailbox past its daily limit while a global rate limit is set', async () => {
    useMailbox(STEADY);
    mailboxSent['mb-1'] = 100;

    expect((await test()).status).toBe(200);
    expect(mockedSend).toHaveBeenCalledTimes(1);
  });

  it('refuses the test from a warming mailbox at its ramp cap while a global rate limit is set', async () => {
    mailboxSent['mb-1'] = 50;

    const res = await test();
    expect(res.status).toBe(429);
    expect((await res.json()).error).toMatch(/has reached its warmup cap of 50 emails/);
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it('refuses the test from a mailbox at its daily limit when no global rate limit is set', async () => {
    mockedPrisma.globalSettings.findUnique.mockResolvedValue({ ...AZURE_SETTINGS, rateLimitMinute: null, rateLimitHour: null });
    useMailbox(STEADY);
    mailboxSent['mb-1'] = 100;

    const res = await test();
    const data = await res.json();
    expect(res.status).toBe(429);
    expect(data.success).toBe(false);
    expect(data.error).toMatch(/has reached its daily cap of 100 emails/);
    expect(mockedSend).not.toHaveBeenCalled();
    expect(mockedPrisma.emailDispatch.create).not.toHaveBeenCalled();
  });

  it('does not record a test the provider refused', async () => {
    mockedSend.mockRejectedValue(new EmailSendError('Recipient address rejected.', { statusCode: 400 }));

    const res = await test();
    expect(res.status).toBe(550);
    expect((await res.json()).error).toBe('Azure Communication Services failed to send: Recipient address rejected.');
    expect(mockedPrisma.emailDispatch.create).not.toHaveBeenCalled();
    expect(mockedPrisma.senderAccount.updateMany).not.toHaveBeenCalled();
  });
});
