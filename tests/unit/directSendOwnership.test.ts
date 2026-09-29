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

/** The SenderAccount table the ownership lookups run against. */
const MAILBOXES = [
  { id: 'mb-user1', userId: 'user-1', emailAddress: 'one@acme.test', name: 'User One', provider: 'AZURE' },
  { id: 'mb-user2', userId: 'user-2', emailAddress: 'two@acme.test', name: 'User Two', provider: 'AZURE' },
];

/** Inbound replies: lead-1 wrote to both users' mailboxes, lead-2 only to user-2's. */
const INBOUND = [
  { id: 'in-1', leadId: 'lead-1', senderAccountId: 'mb-user1', campaignId: 'cmp-old', receivedAt: new Date('2026-09-01') },
  { id: 'in-2', leadId: 'lead-1', senderAccountId: 'mb-user1', campaignId: 'cmp-1', receivedAt: new Date('2026-09-10') },
  { id: 'in-3', leadId: 'lead-1', senderAccountId: 'mb-user2', campaignId: 'cmp-2', receivedAt: new Date('2026-09-05') },
  { id: 'in-4', leadId: 'lead-2', senderAccountId: 'mb-user2', campaignId: 'cmp-2', receivedAt: new Date('2026-09-05') },
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
  mockedPrisma.inboundResponse.findFirst.mockImplementation(async ({ where }: any) => {
    const rows = INBOUND
      .filter((r) => r.leadId === where.leadId)
      .filter((r) => where.senderAccountId === undefined || r.senderAccountId === where.senderAccountId)
      .filter((r) => where.senderAccount === undefined
        || MAILBOXES.find((m) => m.id === r.senderAccountId)?.userId === where.senderAccount.userId)
      .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());
    return rows[0] ?? null;
  });
  mockedPrisma.emailDispatch.create.mockImplementation(async ({ data }: any) => ({ id: 'dispatch-1', ...data }));
});

describe('POST /api/unibox/reply mailbox ownership (H25)', () => {
  beforeEach(() => {
    mockedPrisma.globalSettings.findUnique.mockResolvedValue(AZURE_SETTINGS);
    mockedPrisma.lead.findUnique.mockImplementation(async ({ where }: any) =>
      ({ id: where.id, email: `${where.id}@prospect.test`, name: 'Prospect' }),
    );
  });

  const reply = (body: Record<string, unknown>) =>
    postUniboxReply(makeReq('/api/unibox/reply', { subject: 'Re: Hello', body: 'Thanks!', ...body }));

  it('sends from the caller\'s own mailbox and records the mailbox and campaign on the dispatch', async () => {
    const res = await reply({ leadId: 'lead-1', senderAccountId: 'mb-user1' });
    expect(res.status).toBe(200);

    expect(mockedSend).toHaveBeenCalledTimes(1);
    expect(mockedSend.mock.calls[0][0].sender.emailAddress).toBe('one@acme.test');
    expect(mockedPrisma.emailDispatch.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        leadId: 'lead-1',
        senderAccountId: 'mb-user1',
        campaignId: 'cmp-1',
        messageId: 'provider-msg-1',
        status: 'Sent',
      }),
    });
  });

  it('rejects another user\'s mailbox even when the lead replied to the caller', async () => {
    const res = await reply({ leadId: 'lead-1', senderAccountId: 'mb-user2' });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('Sender mailbox does not belong to you.');
    expect(mockedSend).not.toHaveBeenCalled();
    expect(mockedPrisma.emailDispatch.create).not.toHaveBeenCalled();
  });

  it('rejects unknown mailbox IDs the same way', async () => {
    const res = await reply({ leadId: 'lead-1', senderAccountId: 'mb-missing' });
    expect(res.status).toBe(403);
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it('rejects leads that never replied to one of the caller\'s mailboxes', async () => {
    for (const body of [{ leadId: 'lead-2', senderAccountId: 'mb-user1' }, { leadId: 'lead-2' }]) {
      const res = await reply(body);
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe('This lead has not replied to any of your mailboxes.');
    }
    expect(mockedSend).not.toHaveBeenCalled();
    expect(mockedPrisma.emailDispatch.create).not.toHaveBeenCalled();
  });

  it('lets an ADMIN reply from any mailbox to any lead', async () => {
    mockedSession.mockResolvedValue(ADMIN);

    const res = await reply({ leadId: 'lead-2', senderAccountId: 'mb-user2' });
    expect(res.status).toBe(200);
    expect(mockedSend.mock.calls[0][0].sender.emailAddress).toBe('two@acme.test');
    expect(mockedPrisma.emailDispatch.create.mock.calls[0][0].data).toMatchObject({
      senderAccountId: 'mb-user2',
      campaignId: 'cmp-2',
    });
  });

  it('returns 404 to an ADMIN naming an unknown mailbox', async () => {
    mockedSession.mockResolvedValue(ADMIN);
    const res = await reply({ leadId: 'lead-1', senderAccountId: 'mb-missing' });
    expect(res.status).toBe(404);
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it('rejects non-string lead and mailbox IDs before sending', async () => {
    const badLead = await reply({ leadId: { not: 'x' }, senderAccountId: 'mb-user1' });
    expect(badLead.status).toBe(400);
    expect(mockedPrisma.inboundResponse.findFirst).not.toHaveBeenCalled();

    const badMailbox = await reply({ leadId: 'lead-1', senderAccountId: { not: 'x' } });
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
