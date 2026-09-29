import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * The real lib/db runs against this fake client, so db.getCampaigns and the
 * routes build their own queries. Included mailboxes follow Prisma's rules:
 * `true` loads every column, `{ omit }` drops the listed ones.
 */
const fake = vi.hoisted(() => {
  const model = (...names: string[]) => Object.fromEntries(names.map((n) => [n, vi.fn()]));
  return {
    user: model('findUnique'),
    campaign: model('findMany', 'findUnique', 'update'),
    campaignEnrollment: model('count', 'groupBy', 'findMany', 'createMany', 'deleteMany'),
    emailDispatch: model('count', 'groupBy', 'findMany'),
    inboundResponse: model('count', 'findMany', 'findUnique', 'update'),
    lead: model('count', 'groupBy', 'findMany'),
    $transaction: vi.fn(),
  };
});

vi.mock('@prisma/client', () => ({
  PrismaClient: class {
    constructor() {
      return fake;
    }
  },
}));

vi.mock('../../lib/session', () => ({
  getSession: vi.fn(),
}));

vi.mock('../../lib/imapService', () => ({
  syncMailboxReplies: vi.fn(),
  getActiveImapAccounts: vi.fn(),
}));

import { db } from '../../lib/db';
import { getSession } from '../../lib/session';
import { getActiveImapAccounts } from '../../lib/imapService';
import { GET as getCampaigns } from '../../app/api/campaigns/route';
import { GET as getCampaign, PUT as putCampaign } from '../../app/api/campaigns/[id]/route';
import { GET as getUnibox, PUT as putUnibox } from '../../app/api/unibox/route';

const mockedSession = vi.mocked(getSession);

const USER = { id: 'user-1', name: 'User', email: 'user@example.com', role: 'USER' as const };

/** A mailbox saved before encryption: both passwords are stored as plaintext. */
const MAILBOX = {
  id: 'acc-1',
  userId: 'user-1',
  emailAddress: 'sender@example.com',
  provider: 'AZURE',
  smtpHost: 'smtp.example.com',
  smtpUser: 'sender@example.com',
  smtpPass: 'legacy-smtp-password',
  imapHost: 'imap.example.com',
  imapUser: 'sender@example.com',
  imapPass: 'legacy-imap-password',
};

function includedMailbox(sel: true | { omit?: Record<string, boolean> }) {
  const row: Record<string, unknown> = { ...MAILBOX };
  if (sel !== true) {
    for (const [key, on] of Object.entries(sel.omit ?? {})) if (on) delete row[key];
  }
  return row;
}

function campaignRow(include?: any) {
  const row: Record<string, unknown> = {
    id: 'cmp-1', name: 'Launch', userId: 'user-1', status: 'Draft', audienceCohort: 'Valid', senderAccountId: 'acc-1',
  };
  if (include) {
    row.steps = [];
    row.senderAccount = includedMailbox(include.senderAccount);
    row.senders = [{
      campaignId: 'cmp-1',
      senderAccountId: 'acc-1',
      senderAccount: includedMailbox(include.senders.include.senderAccount),
    }];
  }
  return row;
}

function replyRow(include: any) {
  return {
    id: 'reply-1',
    leadId: 'lead-1',
    campaignId: null,
    subject: 'Re: Hello',
    body: 'Thanks',
    receivedAt: new Date('2026-09-01'),
    unread: true,
    senderAccountId: 'acc-1',
    lead: { id: 'lead-1', email: 'lead@example.com', enrollments: [] },
    campaign: null,
    senderAccount: includedMailbox(include.senderAccount),
  };
}

function makeReq(path: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function expectNoMailboxSecrets(res: Response) {
  expect(res.status).toBe(200);
  const text = JSON.stringify(await res.json());
  expect(text).toContain(MAILBOX.emailAddress);
  expect(text).not.toContain('smtpPass');
  expect(text).not.toContain('imapPass');
  expect(text).not.toContain(MAILBOX.smtpPass);
  expect(text).not.toContain(MAILBOX.imapPass);
}

const params = { params: Promise.resolve({ id: 'cmp-1' }) };

describe('mailbox secrets in API responses', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockedSession.mockResolvedValue(USER);
    vi.mocked(getActiveImapAccounts).mockResolvedValue([]);
    fake.user.findUnique.mockResolvedValue({ id: 'user-1' });
    for (const m of [fake.campaignEnrollment, fake.emailDispatch, fake.inboundResponse, fake.lead]) {
      m.count?.mockResolvedValue(0);
      m.groupBy?.mockResolvedValue([]);
      m.findMany?.mockResolvedValue([]);
    }
    fake.campaign.findMany.mockImplementation(async (args: any) => [campaignRow(args.include)]);
    fake.campaign.findUnique.mockImplementation(async (args: any) => campaignRow(args.include));
    fake.$transaction.mockImplementation(async (fn: (tx: typeof fake) => unknown) => fn(fake));
  });

  it('db.getCampaigns leaves the passwords off the primary and pool mailboxes', async () => {
    const [campaign] = (await db.getCampaigns('user-1', 'USER')) as any[];
    expect(campaign.senderAccount.emailAddress).toBe(MAILBOX.emailAddress);
    expect(campaign.senderAccount).not.toHaveProperty('smtpPass');
    expect(campaign.senderAccount).not.toHaveProperty('imapPass');
    expect(campaign.senders[0].senderAccount).not.toHaveProperty('smtpPass');
    expect(campaign.senders[0].senderAccount).not.toHaveProperty('imapPass');
  });

  it('GET /api/campaigns returns no mailbox passwords', async () => {
    await expectNoMailboxSecrets(await getCampaigns());
  });

  it('GET /api/campaigns/[id] returns no mailbox passwords', async () => {
    await expectNoMailboxSecrets(await getCampaign(makeReq('/api/campaigns/cmp-1', 'GET'), params));
  });

  it('PUT /api/campaigns/[id] returns the updated campaign without mailbox passwords', async () => {
    await expectNoMailboxSecrets(await putCampaign(makeReq('/api/campaigns/cmp-1', 'PUT', { name: 'Renamed' }), params));
    expect(fake.campaign.update).toHaveBeenCalledWith({ where: { id: 'cmp-1' }, data: { name: 'Renamed' } });
  });

  it('GET /api/unibox returns threads without mailbox passwords', async () => {
    fake.inboundResponse.findMany.mockImplementation(async (args: any) => [replyRow(args.include)]);
    await expectNoMailboxSecrets(await getUnibox(makeReq('/api/unibox', 'GET')));
  });

  it('PUT /api/unibox returns the updated reply without mailbox passwords', async () => {
    fake.inboundResponse.count.mockResolvedValue(1);
    fake.inboundResponse.findUnique.mockImplementation(async (args: any) => replyRow(args.include));
    await expectNoMailboxSecrets(await putUnibox(makeReq('/api/unibox', 'PUT', { responseId: 'reply-1', unread: false })));
    expect(fake.inboundResponse.update).toHaveBeenCalledWith({ where: { id: 'reply-1' }, data: { unread: false } });
  });
});
