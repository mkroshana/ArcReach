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
    campaign: model('findMany', 'findUnique', 'updateMany'),
    campaignEnrollment: model('count', 'groupBy', 'findMany', 'createMany', 'deleteMany'),
    emailDispatch: model('count', 'groupBy', 'findMany'),
    inboundResponse: model('count', 'findMany'),
    lead: model('count', 'groupBy', 'findMany'),
    suppressedEmail: model('findMany'),
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
  };
});

// The rest of the module is real: lib/engagementMetrics builds SQL with Prisma.sql.
vi.mock('@prisma/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@prisma/client')>()),
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
import { GET as getUnibox } from '../../app/api/unibox/route';

const mockedSession = vi.mocked(getSession);

const USER = { id: 'user-1', name: 'User', email: 'user@example.com', role: 'USER' as const };

/** A mailbox saved before encryption: its IMAP password is stored as plaintext. */
const MAILBOX = {
  id: 'acc-1',
  userId: 'user-1',
  emailAddress: 'sender@example.com',
  provider: 'AZURE',
  imapHost: 'imap.example.com',
  imapUser: 'sender@example.com',
  imapPass: 'legacy-imap-password',
};

function includedMailbox(sel: true | { omit?: Record<string, boolean>; select?: Record<string, boolean> }) {
  const row: Record<string, unknown> = { ...MAILBOX };
  if (sel !== true && sel.select) {
    const select = sel.select;
    return Object.fromEntries(Object.keys(select).filter((key) => select[key]).map((key) => [key, row[key]]));
  }
  if (sel !== true) {
    for (const [key, on] of Object.entries(sel.omit ?? {})) if (on) delete row[key];
  }
  return row;
}

const UPDATED_AT = new Date('2026-09-01T10:00:00.000Z');

function campaignRow(include?: any) {
  const row: Record<string, unknown> = {
    id: 'cmp-1', name: 'Launch', userId: 'user-1', status: 'Draft', audienceCohort: 'Valid', senderAccountId: 'acc-1',
    updatedAt: UPDATED_AT,
  };
  // PUT's first read loads only the owner, to refuse Publish while they are disabled.
  if (include?.user) row.user = { disabledAt: null };
  if (include?.senders) {
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

/** Only the `select`ed columns of `row`, relations by their own select, as Prisma loads them. */
function selectFrom(row: any, select: Record<string, any>): any {
  if (Array.isArray(row)) return row.map((item) => selectFrom(item, select));
  if (row == null) return row;
  return Object.fromEntries(Object.entries(select).filter(([, on]) => on).map(([key, on]) => [key, on === true ? row[key] : selectFrom(row[key], on.select)]));
}

/** The campaigns list row as its findMany `select` loads it, from a row that has every mailbox column. */
function listedCampaign(select: any) {
  return selectFrom({
    ...campaignRow(),
    createdAt: UPDATED_AT,
    user: { id: 'user-1', name: 'User', email: 'user@example.com' },
    steps: [],
    senderAccount: MAILBOX,
    senders: [{ campaignId: 'cmp-1', senderAccountId: 'acc-1', senderAccount: MAILBOX }],
  }, select);
}

const LEAD_ID = '11111111-2222-3333-4444-555555555555';

/** A reply loaded with `include` or `select`; its mailbox comes only when asked for. */
function replyRow(include: any) {
  return {
    id: 'reply-1',
    leadId: LEAD_ID,
    campaignId: null,
    subject: 'Re: Hello',
    body: 'Thanks',
    receivedAt: new Date('2026-09-01'),
    unread: true,
    senderAccountId: 'acc-1',
    lead: { id: LEAD_ID, email: 'lead@example.com', enrollments: [] },
    campaign: null,
    senderAccount: include.senderAccount ? includedMailbox(include.senderAccount) : undefined,
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
  expect(text).not.toContain('imapPass');
  expect(text).not.toContain(MAILBOX.imapPass);
}

const params = { params: Promise.resolve({ id: 'cmp-1' }) };

describe('mailbox secrets in API responses', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockedSession.mockResolvedValue(USER);
    vi.mocked(getActiveImapAccounts).mockResolvedValue([]);
    fake.user.findUnique.mockResolvedValue({ id: 'user-1' });
    for (const m of [fake.campaignEnrollment, fake.emailDispatch, fake.inboundResponse, fake.lead, fake.suppressedEmail]) {
      m.count?.mockResolvedValue(0);
      m.groupBy?.mockResolvedValue([]);
      m.findMany?.mockResolvedValue([]);
    }
    fake.campaign.findMany.mockImplementation(async (args: any) => [listedCampaign(args.select)]);
    fake.campaign.findUnique.mockImplementation(async (args: any) => campaignRow(args.include));
    fake.$transaction.mockImplementation(async (fn: (tx: typeof fake) => unknown) => fn(fake));
    fake.$queryRaw.mockResolvedValue([]);
  });

  it('db.getCampaigns loads only the primary mailbox address, and no pool mailboxes', async () => {
    const [campaign] = (await db.getCampaigns('user-1', 'USER')) as any[];
    expect(campaign.senderAccount).toEqual({ emailAddress: MAILBOX.emailAddress });
    expect(campaign).not.toHaveProperty('senders');
  });

  it('GET /api/campaigns returns no mailbox passwords', async () => {
    await expectNoMailboxSecrets(await getCampaigns());
  });

  it('GET /api/campaigns/[id] returns no mailbox passwords', async () => {
    await expectNoMailboxSecrets(await getCampaign(makeReq('/api/campaigns/cmp-1', 'GET'), params));
  });

  it('PUT /api/campaigns/[id] returns the updated campaign without mailbox passwords', async () => {
    fake.campaign.updateMany.mockResolvedValue({ count: 1 });
    // An enrolled campaign, so a save that keeps its audience runs no enrollment sync.
    fake.campaignEnrollment.count.mockResolvedValue(1);
    await expectNoMailboxSecrets(await putCampaign(makeReq('/api/campaigns/cmp-1', 'PUT', { name: 'Renamed', updatedAt: UPDATED_AT.toISOString() }), params));
    expect(fake.campaign.updateMany).toHaveBeenCalledWith({
      where: { id: 'cmp-1', updatedAt: UPDATED_AT },
      data: { name: 'Renamed', updatedAt: expect.any(Date) },
    });
  });

  it('GET /api/unibox returns threads without mailbox passwords', async () => {
    fake.inboundResponse.findMany.mockImplementation(async (args: any) => [replyRow(args.select)]);
    await expectNoMailboxSecrets(await getUnibox(makeReq('/api/unibox', 'GET')));
  });

  it('GET /api/unibox?thread= returns the messages without mailbox passwords', async () => {
    fake.inboundResponse.findMany.mockImplementation(async (args: any) => [replyRow(args.select)]);
    await expectNoMailboxSecrets(await getUnibox(makeReq(`/api/unibox?thread=${LEAD_ID}-hello`, 'GET')));
  });
});
