import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('../../lib/db', () => ({
  prisma: {
    senderAccount: { findUnique: vi.fn(), updateMany: vi.fn() },
    inboundResponse: { findFirst: vi.fn() },
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
import {
  REFERENCES_MAX_IDS,
  isHeaderMessageId,
  replySubject,
  replyThreadingHeaders,
  threadReferences,
} from '../../lib/replyThreading';
import { replyDedupeKey } from '../../lib/imapService';
import { POST as postUniboxReply } from '../../app/api/unibox/reply/route';

const mockedPrisma = prisma as any;
const mockedSession = vi.mocked(getSession);
const mockedSend = vi.mocked(sendMessage);

const USER = { id: 'user-1', name: 'User', email: 'user@example.com', role: 'USER' as const };

const AZURE_SETTINGS = { id: 'global', activeProvider: 'AZURE', azureConnString: 'enc:v1:conn', azureSenderDomains: ['acme.test'] };

const MAILBOX = {
  id: 'mb-1', userId: 'user-1', emailAddress: 'sales@acme.test', name: 'Sales', replyTo: null,
  warmupEnabled: false, warmupStartedAt: null, dailyLimit: 100, warmupLimit: 10, warmupRamp: 5,
};

/** Amy's second reply in a campaign thread, as IMAP sync records it. */
const AMY_REPLY = {
  id: 'in-2', leadId: 'lead-amy', campaignId: 'cmp-q3', senderAccountId: 'mb-1',
  subject: 'Re: Q3 pipeline review',
  messageId: '<amy-2@acme.test>',
  references: '<acs-step-1@mail.test> <amy-1@acme.test> <acs-reply-1@mail.test>',
  lead: { email: 'amy@acme.test' },
};

function ids(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `<id-${i}@mail.test>`);
}

describe('threading helpers (M58)', () => {
  it('stores the References ids of a received reply, unfolded to single spaces', () => {
    expect(threadReferences('<b@x.test>', '<a@x.test>\t<b@x.test>')).toBe('<a@x.test> <b@x.test>');
  });

  it('falls back to a single In-Reply-To id, as a reply builds References', () => {
    expect(threadReferences('<a@x.test>', '')).toBe('<a@x.test>');
    expect(threadReferences('<a@x.test> <b@x.test>', '')).toBeNull();
    expect(threadReferences('', '')).toBeNull();
    expect(threadReferences()).toBeNull();
  });

  it('keeps only ids a header can carry as they are', () => {
    const long = `<${'x'.repeat(300)}@mail.test>`;
    expect(threadReferences('', `<ok@x.test> <müller@x.test> ${long} not-an-id`)).toBe('<ok@x.test>');
    expect(isHeaderMessageId('<a@x.test>')).toBe(true);
    for (const bad of [null, '', 'a@x.test', '<a b@x.test>', '<a@x.test> <b@x.test>', 'uid 9 7', `sha256 ${'0'.repeat(64)}`]) {
      expect(isHeaderMessageId(bad)).toBe(false);
    }
  });

  it('caps a long chain at the thread\'s first id and its latest ones', () => {
    const chain = ids(30);
    const stored = threadReferences('', chain.join(' '))!.split(' ');
    expect(stored).toHaveLength(REFERENCES_MAX_IDS);
    expect(stored[0]).toBe(chain[0]);
    expect(stored.slice(1)).toEqual(chain.slice(30 - (REFERENCES_MAX_IDS - 1)));
  });

  it('names the parent in In-Reply-To and after its chain in References', () => {
    expect(replyThreadingHeaders(AMY_REPLY)).toEqual({
      'In-Reply-To': '<amy-2@acme.test>',
      References: '<acs-step-1@mail.test> <amy-1@acme.test> <acs-reply-1@mail.test> <amy-2@acme.test>',
    });
  });

  it('threads a reply recorded before its References were stored on its Message-ID alone', () => {
    expect(replyThreadingHeaders({ messageId: '<amy-2@acme.test>', references: null })).toEqual({
      'In-Reply-To': '<amy-2@acme.test>',
      References: '<amy-2@acme.test>',
    });
  });

  it('never puts a hashed or UID stand-in key in a header', () => {
    const hashed = replyDedupeKey(`<${'x'.repeat(300)}@mail.test>`, 9, 7);
    const standIn = replyDedupeKey('', 9, 7);
    expect(replyThreadingHeaders({ messageId: hashed, references: '<a@x.test>' })).toEqual({ References: '<a@x.test>' });
    expect(replyThreadingHeaders({ messageId: standIn, references: null })).toEqual({});
    expect(replyThreadingHeaders({ messageId: null, references: null })).toEqual({});
  });

  it('keeps the thread\'s first id and ends References with the parent when the chain is full', () => {
    const chain = ids(REFERENCES_MAX_IDS);
    const refs = replyThreadingHeaders({ messageId: '<parent@x.test>', references: chain.join(' ') }).References.split(' ');
    expect(refs).toHaveLength(REFERENCES_MAX_IDS);
    expect(refs[0]).toBe(chain[0]);
    expect(refs[1]).toBe(chain[2]);
    expect(refs[refs.length - 1]).toBe('<parent@x.test>');
  });

  it('titles a reply "Re: " and the subject, once, decoding encoded words', () => {
    expect(replySubject('Q3 pipeline review')).toBe('Re: Q3 pipeline review');
    expect(replySubject('  RE: Q3 pipeline review ')).toBe('RE: Q3 pipeline review');
    expect(replySubject('=?UTF-8?Q?Gr=C3=BC=C3=9Fe?=')).toBe('Re: Grüße');
  });
});

function makeReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/unibox/reply', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/unibox/reply threading (M58)', () => {
  let answered: Record<string, unknown>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    answered = AMY_REPLY;
    mockedSession.mockResolvedValue(USER);
    mockedSend.mockResolvedValue({ providerMessageId: 'op-1' });
    mockedPrisma.globalSettings.findUnique.mockResolvedValue(AZURE_SETTINGS);
    mockedPrisma.senderAccount.findUnique.mockResolvedValue(MAILBOX);
    mockedPrisma.inboundResponse.findFirst.mockImplementation(async ({ where }: any) => (where.id === 'in-2' ? answered : null));
    mockedPrisma.emailDispatch.count.mockResolvedValue(0);
    mockedPrisma.emailDispatch.create.mockImplementation(async ({ data }: any) => ({ id: 'dispatch-1', ...data }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const reply = () => postUniboxReply(makeReq({ responseId: 'in-2', senderAccountId: 'mb-1', body: 'Thursday at 2pm works.' }));

  it('sends under "Re: " and the answered reply\'s subject with In-Reply-To and References naming it', async () => {
    const res = await reply();
    expect(res.status).toBe(200);

    expect(mockedSend).toHaveBeenCalledTimes(1);
    expect(mockedSend.mock.calls[0][0]).toMatchObject({
      to: 'amy@acme.test',
      subject: 'Re: Q3 pipeline review',
      body: 'Thursday at 2pm works.',
      isHtml: false,
      sender: { id: 'mb-1', emailAddress: 'sales@acme.test' },
      headers: {
        'In-Reply-To': '<amy-2@acme.test>',
        References: '<acs-step-1@mail.test> <amy-1@acme.test> <acs-reply-1@mail.test> <amy-2@acme.test>',
      },
    });
    expect(mockedPrisma.inboundResponse.findFirst.mock.calls[0][0].select).toMatchObject({ messageId: true, references: true, subject: true });
  });

  it('records the reply against the sending mailbox and the answered reply\'s campaign, under the subject it went out with', async () => {
    await reply();

    expect(mockedPrisma.emailDispatch.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        leadId: 'lead-amy',
        campaignId: 'cmp-q3',
        senderAccountId: 'mb-1',
        messageId: 'op-1',
        subject: 'Re: Q3 pipeline review',
        body: 'Thursday at 2pm works.',
        status: 'Sent',
      }),
    });
  });

  it('ignores a subject the client sends', async () => {
    await postUniboxReply(makeReq({ responseId: 'in-2', senderAccountId: 'mb-1', body: 'Hi', subject: 'Special offer' }));

    expect(mockedSend.mock.calls[0][0].subject).toBe('Re: Q3 pipeline review');
  });

  it('still sends a reply to a message recorded before Message-IDs were stored, with no threading headers', async () => {
    answered = { ...AMY_REPLY, subject: 'Q3 pipeline review', messageId: null, references: null };

    expect((await reply()).status).toBe(200);
    expect(mockedSend.mock.calls[0][0].subject).toBe('Re: Q3 pipeline review');
    expect(mockedSend.mock.calls[0][0].headers).toEqual({});
  });

  it('sends nothing for an unknown reply', async () => {
    const res = await postUniboxReply(makeReq({ responseId: 'in-missing', senderAccountId: 'mb-1', body: 'Hi' }));

    expect(res.status).toBe(404);
    expect(mockedSend).not.toHaveBeenCalled();
    expect(mockedPrisma.emailDispatch.create).not.toHaveBeenCalled();
  });
});
