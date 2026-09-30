import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('../../lib/db', () => ({
  prisma: {
    senderAccount: { findUnique: vi.fn() },
    inboundResponse: { findFirst: vi.fn() },
    lead: { findUnique: vi.fn() },
    globalSettings: { findUnique: vi.fn(), findFirst: vi.fn() },
    emailDispatch: { create: vi.fn(), count: vi.fn() },
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
import { sendMessage } from '../../lib/emailProvider';
import { POST as postUniboxReply } from '../../app/api/unibox/reply/route';
import { POST as postTestEmail } from '../../app/api/send-email/test/route';

const mockedPrisma = prisma as any;
const mockedSession = vi.mocked(getSession);
const mockedSend = vi.mocked(sendMessage);

const USER = { id: 'user-1', name: 'User', email: 'user@example.com', role: 'USER' as const };
const ADMIN = { id: 'admin-1', name: 'Admin', email: 'admin@example.com', role: 'ADMIN' as const };

/** Caps that leave room to send, so only ownership decides these tests. */
const UNDER_CAP = { warmupEnabled: false, warmupStartedAt: null, dailyLimit: 100, warmupLimit: 10, warmupRamp: 5 };

/** The SenderAccount table the ownership lookups run against. */
const MAILBOXES = [
  { id: 'mb-user1', userId: 'user-1', emailAddress: 'one@acme.test', name: 'User One', provider: 'AZURE', ...UNDER_CAP },
  { id: 'mb-user2', userId: 'user-2', emailAddress: 'two@acme.test', name: 'User Two', provider: 'AZURE', ...UNDER_CAP },
];

/** Inbound replies: lead-1 wrote to both users' mailboxes, lead-2 only to user-2's. */
const INBOUND = [
  { id: 'in-1', leadId: 'lead-1', senderAccountId: 'mb-user1', campaignId: 'cmp-old', subject: 'Re: Hello', messageId: null, references: null },
  { id: 'in-2', leadId: 'lead-1', senderAccountId: 'mb-user1', campaignId: 'cmp-1', subject: 'Re: Hello', messageId: null, references: null },
  { id: 'in-3', leadId: 'lead-1', senderAccountId: 'mb-user2', campaignId: 'cmp-2', subject: 'Re: Hello', messageId: null, references: null },
  { id: 'in-4', leadId: 'lead-2', senderAccountId: 'mb-user2', campaignId: 'cmp-2', subject: 'Re: Hello', messageId: null, references: null },
];

/** Azure selected and configured, so the sending guard lets these routes through. */
const AZURE_SETTINGS = { id: 'global', activeProvider: 'AZURE', azureConnString: 'enc:v1:conn', azureSenderDomains: ['acme.test'] };

function makeReq(path: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedSession.mockResolvedValue(USER);
  mockedSend.mockResolvedValue({ providerMessageId: 'provider-msg-1' });
  mockedPrisma.senderAccount.findUnique.mockImplementation(async ({ where }: any) =>
    MAILBOXES.find((m) => m.id === where.id) ?? null,
  );
  // The answered reply by id, limited to the caller's mailboxes when the route scopes it
  mockedPrisma.inboundResponse.findFirst.mockImplementation(async ({ where }: any) => {
    const row = INBOUND
      .filter((r) => r.id === where.id)
      .find((r) => where.senderAccount === undefined
        || MAILBOXES.find((m) => m.id === r.senderAccountId)?.userId === where.senderAccount.userId);
    return row ? { ...row, lead: { email: `${row.leadId}@prospect.test` } } : null;
  });
  mockedPrisma.emailDispatch.create.mockImplementation(async ({ data }: any) => ({ id: 'dispatch-1', ...data }));
  mockedPrisma.emailDispatch.count.mockResolvedValue(0);
});

describe('POST /api/unibox/reply mailbox ownership (H25)', () => {
  beforeEach(() => {
    mockedPrisma.globalSettings.findUnique.mockResolvedValue(AZURE_SETTINGS);
  });

  const reply = (body: Record<string, unknown>) =>
    postUniboxReply(makeReq('/api/unibox/reply', { body: 'Thanks!', ...body }));

  it('sends from the caller\'s own mailbox and records the mailbox and the answered reply\'s campaign', async () => {
    const res = await reply({ responseId: 'in-1', senderAccountId: 'mb-user1' });
    expect(res.status).toBe(200);

    expect(mockedSend).toHaveBeenCalledTimes(1);
    expect(mockedSend.mock.calls[0][0].sender.emailAddress).toBe('one@acme.test');
    expect(mockedSend.mock.calls[0][0].to).toBe('lead-1@prospect.test');
    expect(mockedPrisma.emailDispatch.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        leadId: 'lead-1',
        senderAccountId: 'mb-user1',
        // in-1's campaign, not that of the lead's later reply in-2
        campaignId: 'cmp-old',
        messageId: 'provider-msg-1',
        status: 'Sent',
      }),
    });
  });

  it('rejects another user\'s mailbox even when the reply reached the caller', async () => {
    const res = await reply({ responseId: 'in-2', senderAccountId: 'mb-user2' });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('Sender mailbox does not belong to you.');
    expect(mockedSend).not.toHaveBeenCalled();
    expect(mockedPrisma.emailDispatch.create).not.toHaveBeenCalled();
  });

  it('rejects unknown mailbox IDs the same way', async () => {
    const res = await reply({ responseId: 'in-2', senderAccountId: 'mb-missing' });
    expect(res.status).toBe(403);
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it('refuses a reply with no mailbox instead of sending from the caller\'s login address', async () => {
    for (const senderAccountId of [undefined, null, '']) {
      const res = await reply({ responseId: 'in-2', senderAccountId });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('senderAccountId is required: name the mailbox the reply is sent from.');
    }
    expect(mockedSend).not.toHaveBeenCalled();
    expect(mockedPrisma.emailDispatch.create).not.toHaveBeenCalled();
  });

  it('answers replies that reached another user\'s mailbox like unknown ones', async () => {
    for (const responseId of ['in-3', 'in-4', 'in-missing']) {
      const res = await reply({ responseId, senderAccountId: 'mb-user1' });
      expect(res.status).toBe(404);
      expect((await res.json()).error).toBe('Reply not found.');
    }
    expect(mockedPrisma.inboundResponse.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'in-4', senderAccount: { userId: 'user-1' } } }),
    );
    expect(mockedSend).not.toHaveBeenCalled();
    expect(mockedPrisma.emailDispatch.create).not.toHaveBeenCalled();
  });

  it('lets an ADMIN reply from any mailbox to any reply', async () => {
    mockedSession.mockResolvedValue(ADMIN);

    const res = await reply({ responseId: 'in-4', senderAccountId: 'mb-user2' });
    expect(res.status).toBe(200);
    expect(mockedSend.mock.calls[0][0].sender.emailAddress).toBe('two@acme.test');
    expect(mockedPrisma.emailDispatch.create.mock.calls[0][0].data).toMatchObject({
      leadId: 'lead-2',
      senderAccountId: 'mb-user2',
      campaignId: 'cmp-2',
    });
  });

  it('returns 404 to an ADMIN naming an unknown mailbox', async () => {
    mockedSession.mockResolvedValue(ADMIN);
    const res = await reply({ responseId: 'in-1', senderAccountId: 'mb-missing' });
    expect(res.status).toBe(404);
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it('rejects non-string reply and mailbox IDs before sending', async () => {
    const badReply = await reply({ responseId: { not: 'x' }, senderAccountId: 'mb-user1' });
    expect(badReply.status).toBe(400);
    expect(mockedPrisma.inboundResponse.findFirst).not.toHaveBeenCalled();

    const badMailbox = await reply({ responseId: 'in-1', senderAccountId: { not: 'x' } });
    expect(badMailbox.status).toBe(400);
    expect(mockedPrisma.senderAccount.findUnique).not.toHaveBeenCalled();
    expect(mockedSend).not.toHaveBeenCalled();
  });
});

describe('POST /api/send-email/test mailbox ownership (H25)', () => {
  beforeEach(() => {
    mockedPrisma.globalSettings.findUnique.mockResolvedValue(AZURE_SETTINGS);
  });

  const test = (senderAccountId: unknown) => postTestEmail(makeReq('/api/send-email/test', { senderAccountId }));

  it('sends a test from the caller\'s own mailbox to the caller', async () => {
    const res = await test('mb-user1');
    expect(res.status).toBe(200);
    expect(mockedSend).toHaveBeenCalledTimes(1);
    expect(mockedSend.mock.calls[0][0]).toMatchObject({
      to: 'user@example.com',
      sender: { id: 'mb-user1', emailAddress: 'one@acme.test' },
    });
  });

  it('rejects another user\'s mailbox and unknown IDs alike', async () => {
    for (const id of ['mb-user2', 'mb-missing']) {
      const res = await test(id);
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe('Sender mailbox does not belong to you.');
    }
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it('lets an ADMIN test any mailbox and 404s unknown ones', async () => {
    mockedSession.mockResolvedValue(ADMIN);

    const ok = await test('mb-user2');
    expect(ok.status).toBe(200);
    expect(mockedSend.mock.calls[0][0].sender.emailAddress).toBe('two@acme.test');

    const missing = await test('mb-missing');
    expect(missing.status).toBe(404);
    expect(mockedSend).toHaveBeenCalledTimes(1);
  });

  it('rejects a non-string mailbox ID before querying', async () => {
    const res = await test({ not: 'x' });
    expect(res.status).toBe(400);
    expect(mockedPrisma.senderAccount.findUnique).not.toHaveBeenCalled();
    expect(mockedSend).not.toHaveBeenCalled();
  });
});
