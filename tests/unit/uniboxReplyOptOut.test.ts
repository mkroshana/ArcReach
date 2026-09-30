import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('../../lib/db', () => ({
  prisma: {
    senderAccount: { findUnique: vi.fn(), updateMany: vi.fn() },
    inboundResponse: { findFirst: vi.fn() },
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
import { sendMessage } from '../../lib/emailProvider';
import { replyBlockedReason } from '../../lib/suppression';
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

const UNSUBSCRIBED_AT = new Date('2026-09-12T10:00:00Z');

/** The suppression list, keyed by normalised address. */
let suppressed: Record<string, { reason: string; source: string; createdAt: Date }>;
/** The answered reply's lead, as the route selects it; the address is stored as typed to check the list is read normalised. */
let lead: { email: string; status: string };

function makeReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/unibox/reply', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const reply = () => postUniboxReply(makeReq({ responseId: 'in-1', senderAccountId: 'mb-1', body: 'Thanks for getting back to me.' }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  suppressed = {};
  lead = { email: ' Amy@Acme.test ', status: 'Neutral' };
  mockedSession.mockResolvedValue(USER);
  mockedSend.mockResolvedValue({ providerMessageId: 'op-1' });
  mockedPrisma.globalSettings.findUnique.mockResolvedValue(AZURE_SETTINGS);
  mockedPrisma.senderAccount.findUnique.mockResolvedValue(MAILBOX);
  mockedPrisma.inboundResponse.findFirst.mockImplementation(async () => ({
    leadId: 'lead-amy', campaignId: 'cmp-1', subject: 'Q3 pipeline review', messageId: '<amy-1@acme.test>', references: null, lead,
  }));
  mockedPrisma.suppressedEmail.findMany.mockImplementation(async ({ where }: any) =>
    (where.email.in as string[]).flatMap((email) => (suppressed[email] ? [{ email, ...suppressed[email] }] : [])),
  );
  mockedPrisma.emailDispatch.count.mockResolvedValue(0);
  mockedPrisma.emailDispatch.create.mockImplementation(async ({ data }: any) => ({ id: 'dispatch-1', ...data }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function expectBlocked(message: string) {
  const res = await reply();
  expect(res.status).toBe(409);
  expect((await res.json()).error).toBe(message);
  expect(mockedSend).not.toHaveBeenCalled();
  expect(mockedPrisma.emailDispatch.create).not.toHaveBeenCalled();
  expect(mockedPrisma.senderAccount.updateMany).not.toHaveBeenCalled();
}

describe('POST /api/unibox/reply to a person who opted out (owner decision)', () => {
  it('refuses a reply to an address that unsubscribed, naming the date, and sends and records nothing', async () => {
    suppressed['amy@acme.test'] = { reason: 'Unsubscribed', source: 'unsubscribe-link', createdAt: UNSUBSCRIBED_AT };
    lead.status = 'Unsubscribed';

    await expectBlocked('This person unsubscribed on Sep 12, 2026. Replies to them are blocked.');
    expect(mockedPrisma.suppressedEmail.findMany.mock.calls[0][0].where).toEqual({ email: { in: ['amy@acme.test'] } });
  });

  it('refuses a reply to an address that reported an email as spam', async () => {
    suppressed['amy@acme.test'] = { reason: 'Complaint', source: 'delivery-webhook', createdAt: UNSUBSCRIBED_AT };
    lead.status = 'Unsubscribed';

    await expectBlocked('This person reported an email as spam on Sep 12, 2026, which unsubscribed them. Replies to them are blocked.');
  });

  it('refuses a reply to an opt-out whatever CRM status the lead was given since', async () => {
    suppressed['amy@acme.test'] = { reason: 'Unsubscribed', source: 'unsubscribe-link', createdAt: UNSUBSCRIBED_AT };
    lead.status = 'Interested';

    await expectBlocked('This person unsubscribed on Sep 12, 2026. Replies to them are blocked.');
  });

  it('refuses a reply to a lead unsubscribed before the suppression list existed, with no entry on it', async () => {
    lead.status = 'Unsubscribed';

    await expectBlocked('This person unsubscribed. Replies to them are blocked.');
  });

  it('names no date for an opt-out the backfill recorded, whose date is only the backfill\'s', async () => {
    suppressed['amy@acme.test'] = { reason: 'Unsubscribed', source: 'backfill', createdAt: UNSUBSCRIBED_AT };
    lead.status = 'Unsubscribed';

    await expectBlocked('This person unsubscribed. Replies to them are blocked.');
  });

  it('sends a reply to a lead that has not opted out', async () => {
    const res = await reply();

    expect(res.status).toBe(200);
    expect(mockedSend).toHaveBeenCalledTimes(1);
    expect(mockedSend.mock.calls[0][0].to).toBe('amy@acme.test');
    expect(mockedPrisma.emailDispatch.create).toHaveBeenCalledTimes(1);
  });

  it('sends a reply to an address on the list for a hard bounce or a failed verification', async () => {
    suppressed['amy@acme.test'] = { reason: 'HardBounce', source: 'delivery-webhook', createdAt: UNSUBSCRIBED_AT };
    lead.status = 'Bounced';
    expect((await reply()).status).toBe(200);

    suppressed['amy@acme.test'] = { reason: 'Invalid', source: 'verification', createdAt: UNSUBSCRIBED_AT };
    lead.status = 'Neutral';
    expect((await reply()).status).toBe(200);

    expect(mockedSend).toHaveBeenCalledTimes(2);
    expect(mockedPrisma.emailDispatch.create).toHaveBeenCalledTimes(2);
  });

  it('answers 404 for an unknown reply without reading the list', async () => {
    mockedPrisma.inboundResponse.findFirst.mockResolvedValue(null);

    const res = await reply();
    expect(res.status).toBe(404);
    expect(mockedPrisma.suppressedEmail.findMany).not.toHaveBeenCalled();
    expect(mockedSend).not.toHaveBeenCalled();
  });
});

describe('replyBlockedReason (owner decision)', () => {
  const entry = (reason: string, source = 'unsubscribe-link') =>
    ({ reason, source, createdAt: '2026-09-12T10:00:00.000Z' }) as any;

  it('writes the date with the format it is given, as Unibox does from the thread list\'s JSON', () => {
    expect(replyBlockedReason({ status: 'Unsubscribed', suppression: entry('Unsubscribed') }, (d) => d.toISOString().slice(0, 10)))
      .toBe('This person unsubscribed on 2026-09-12. Replies to them are blocked.');
  });

  it('blocks only opt-outs', () => {
    expect(replyBlockedReason({ status: 'Neutral', suppression: null })).toBeNull();
    expect(replyBlockedReason({ status: 'Bounced', suppression: entry('HardBounce', 'send-engine') })).toBeNull();
    expect(replyBlockedReason({ status: 'Neutral', suppression: entry('Invalid', 'verification') })).toBeNull();
    expect(replyBlockedReason({})).toBeNull();
    expect(replyBlockedReason({ status: 'Unsubscribed' })).toBe('This person unsubscribed. Replies to them are blocked.');
  });
});
