import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const tx = vi.hoisted(() => ({
  campaign: { updateMany: vi.fn() },
  campaignSenderAccount: { deleteMany: vi.fn(), createMany: vi.fn() },
  campaignStep: { deleteMany: vi.fn(), createMany: vi.fn() },
}));

vi.mock('../../lib/db', () => ({
  db: {
    createCampaign: vi.fn(),
    getAccounts: vi.fn(),
    updateAccount: vi.fn(),
  },
  prisma: {
    senderAccount: { findMany: vi.fn(), findUnique: vi.fn() },
    campaignSenderAccount: { findMany: vi.fn() },
    campaign: { findUnique: vi.fn(), findMany: vi.fn() },
    lead: { findMany: vi.fn() },
    campaignEnrollment: { count: vi.fn(), createMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock('../../lib/session', () => ({
  getSession: vi.fn(),
}));

vi.mock('../../lib/settings', () => ({
  getGlobalSettings: vi.fn(),
}));

import { db, prisma } from '../../lib/db';
import { getSession } from '../../lib/session';
import { getGlobalSettings } from '../../lib/settings';
import { POST as postCampaign } from '../../app/api/campaigns/route';
import { PUT as putCampaign } from '../../app/api/campaigns/[id]/route';
import { PUT as putAccount } from '../../app/api/accounts/route';
import { planPoolRows } from '../../lib/campaignRouting';
import { NO_OPEN_SENDER_ERROR } from '../../lib/senderRouting';

const mockedDb = db as any;
const mockedPrisma = prisma as any;

const USER = { id: 'user-1', name: 'User', email: 'user@example.com', role: 'USER' as const };

type Mailbox = { id: string; userId: string; recipientDomains: string[] };

/** The SenderAccount table: two mailboxes with no Recipient Domains of their own, and two with. */
let mailboxes: Mailbox[];
const mailbox = (id: string) => mailboxes.find((m) => m.id === id)!;

function makeReq(method: string, path: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mailboxes = [
    { id: 'mb-open', userId: 'user-1', recipientDomains: [] },
    { id: 'mb-open-2', userId: 'user-1', recipientDomains: [] },
    { id: 'mb-gmail', userId: 'user-1', recipientDomains: ['gmail.com'] },
    { id: 'mb-microsoft', userId: 'user-1', recipientDomains: ['outlook.com'] },
  ];
  vi.mocked(getSession).mockResolvedValue(USER);
  vi.mocked(getGlobalSettings).mockResolvedValue({} as any);
  // The ownership query names the owner and selects the id; the routing check reads the mailboxes with their lists.
  mockedPrisma.senderAccount.findMany.mockImplementation(async ({ where, select }: any) =>
    mailboxes
      .filter((m) => where.id.in.includes(m.id) && (where.userId === undefined || m.userId === where.userId))
      .map((m) => (select.recipientDomains ? { ...m } : { id: m.id })),
  );
  mockedPrisma.campaignSenderAccount.findMany.mockResolvedValue([]);
});

describe('planPoolRows', () => {
  it('names the pool from senderAccountIds, once each, with the lists sent for them', () => {
    expect(planPoolRows({ senderAccountIds: ['a', 'b', 'a'], senderRecipientDomains: { b: ['Gmail.com'] } }, [])).toEqual({
      rows: [{ senderAccountId: 'a', recipientDomains: [] }, { senderAccountId: 'b', recipientDomains: ['gmail.com'] }],
      error: null,
    });
  });

  it('keeps the stored list of a mailbox no list is sent for, and drops a mailbox taken out of the pool', () => {
    const stored = [{ senderAccountId: 'a', recipientDomains: ['gmail.com'] }, { senderAccountId: 'gone', recipientDomains: ['outlook.com'] }];
    expect(planPoolRows({ senderAccountIds: ['a', 'b'] }, stored)).toEqual({
      rows: [{ senderAccountId: 'a', recipientDomains: ['gmail.com'] }, { senderAccountId: 'b', recipientDomains: [] }],
      error: null,
    });
  });

  it('leaves the pool as stored when no senderAccountIds are sent, taking only the new lists', () => {
    const stored = [{ senderAccountId: 'a', recipientDomains: ['gmail.com'] }, { senderAccountId: 'b', recipientDomains: [] }];
    expect(planPoolRows({ senderRecipientDomains: { a: [], b: ['outlook.com'] } }, stored)).toEqual({
      rows: [{ senderAccountId: 'a', recipientDomains: [] }, { senderAccountId: 'b', recipientDomains: ['outlook.com'] }],
      error: null,
    });
  });

  it('refuses a list for a mailbox outside the pool', () => {
    expect(planPoolRows({ senderAccountIds: ['a'], senderRecipientDomains: { b: ['gmail.com'] } }, [])).toEqual({
      rows: null,
      error: "Recipient Domains were sent for a mailbox that is not in the campaign's sender pool.",
    });
  });

  it('refuses lists that are not a map of mailbox IDs to domain names', () => {
    expect(planPoolRows({ senderAccountIds: ['a'], senderRecipientDomains: ['gmail.com'] }, []).error)
      .toBe('senderRecipientDomains must map mailbox IDs to lists of domain names.');
    expect(planPoolRows({ senderAccountIds: ['a'], senderRecipientDomains: { a: 'gmail.com' } }, []).error)
      .toBe('Recipient Domains must be a list of domain names.');
    expect(planPoolRows({ senderAccountIds: ['a'], senderRecipientDomains: { a: ['not a domain'] } }, []).error)
      .toBe('"not" is not a domain name. Enter Recipient Domains such as gmail.com.');
  });
});

/** The version a save from the campaign page names: the stored one. */
const UPDATED_AT = new Date('2026-10-01T10:00:00.000Z');

describe('PUT /api/campaigns/[id] Recipient Domains', () => {
  const CAMPAIGN = { id: 'cmp-1', userId: 'user-1', status: 'Draft', audienceCohort: 'Valid', senderAccountId: 'mb-open', updatedAt: UPDATED_AT };

  beforeEach(() => {
    mockedPrisma.campaign.findUnique.mockResolvedValue(CAMPAIGN);
    mockedPrisma.$transaction.mockImplementation(async (fn: any) => fn(tx));
    tx.campaign.updateMany.mockResolvedValue({ count: 1 });
    // An enrolled campaign, so a save that keeps its audience runs no enrollment sync.
    mockedPrisma.campaignEnrollment.count.mockResolvedValue(1);
  });

  const update = (body: Record<string, unknown>) =>
    putCampaign(makeReq('PUT', '/api/campaigns/cmp-1', { updatedAt: UPDATED_AT.toISOString(), ...body }), { params: Promise.resolve({ id: 'cmp-1' }) });

  const refused = async (body: Record<string, unknown>, error: string) => {
    const res = await update(body);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(error);
    expect(mockedPrisma.$transaction).not.toHaveBeenCalled();
  };

  it("stores each pool mailbox with the campaign's list for it, in its stored form", async () => {
    const res = await update({
      senderAccountId: 'mb-open',
      senderAccountIds: ['mb-open', 'mb-open-2'],
      senderRecipientDomains: { 'mb-open': [], 'mb-open-2': ['Gmail.com', '@googlemail.com'] },
    });
    expect(res.status).toBe(200);
    expect(tx.campaignSenderAccount.deleteMany).toHaveBeenCalledWith({ where: { campaignId: 'cmp-1' } });
    expect(tx.campaignSenderAccount.createMany).toHaveBeenCalledWith({
      data: [
        { campaignId: 'cmp-1', senderAccountId: 'mb-open', recipientDomains: [] },
        { campaignId: 'cmp-1', senderAccountId: 'mb-open-2', recipientDomains: ['gmail.com', 'googlemail.com'] },
      ],
    });
  });

  it('keeps the stored list of a pool mailbox when a save sends the pool without lists', async () => {
    mockedPrisma.campaignSenderAccount.findMany.mockResolvedValue([
      { senderAccountId: 'mb-open', recipientDomains: [] },
      { senderAccountId: 'mb-open-2', recipientDomains: ['gmail.com'] },
    ]);
    const res = await update({ senderAccountIds: ['mb-open', 'mb-open-2'] });
    expect(res.status).toBe(200);
    expect(mockedPrisma.campaignSenderAccount.findMany).toHaveBeenCalledWith({
      where: { campaignId: 'cmp-1' },
      select: { senderAccountId: true, recipientDomains: true },
    });
    expect(tx.campaignSenderAccount.createMany).toHaveBeenCalledWith({
      data: [
        { campaignId: 'cmp-1', senderAccountId: 'mb-open', recipientDomains: [] },
        { campaignId: 'cmp-1', senderAccountId: 'mb-open-2', recipientDomains: ['gmail.com'] },
      ],
    });
  });

  it('stores new lists for the stored pool when a save sends lists alone', async () => {
    mockedPrisma.campaignSenderAccount.findMany.mockResolvedValue([
      { senderAccountId: 'mb-open', recipientDomains: [] },
      { senderAccountId: 'mb-open-2', recipientDomains: [] },
    ]);
    const res = await update({ senderRecipientDomains: { 'mb-open-2': ['gmail.com'] } });
    expect(res.status).toBe(200);
    expect(tx.campaignSenderAccount.createMany).toHaveBeenCalledWith({
      data: [
        { campaignId: 'cmp-1', senderAccountId: 'mb-open', recipientDomains: [] },
        { campaignId: 'cmp-1', senderAccountId: 'mb-open-2', recipientDomains: ['gmail.com'] },
      ],
    });
  });

  it('stores a mail provider beside domains, named by its entry or its name alone', async () => {
    const res = await update({
      senderAccountIds: ['mb-open', 'mb-open-2'],
      senderRecipientDomains: { 'mb-open-2': ['Google', 'acme.com', 'provider:yahoo'] },
    });
    expect(res.status).toBe(200);
    expect(tx.campaignSenderAccount.createMany).toHaveBeenCalledWith({
      data: [
        { campaignId: 'cmp-1', senderAccountId: 'mb-open', recipientDomains: [] },
        { campaignId: 'cmp-1', senderAccountId: 'mb-open-2', recipientDomains: ['provider:google', 'acme.com', 'provider:yahoo'] },
      ],
    });
  });

  it('counts a mailbox limited to a mail provider as limited', async () => {
    await refused({
      senderAccountId: 'mb-open',
      senderAccountIds: ['mb-open', 'mb-open-2'],
      senderRecipientDomains: { 'mb-open': ['provider:google'], 'mb-open-2': ['provider:microsoft'] },
    }, NO_OPEN_SENDER_ERROR);
  });

  it('refuses a pool in which the campaign limits every mailbox', async () => {
    await refused({
      senderAccountId: 'mb-open',
      senderAccountIds: ['mb-open', 'mb-open-2'],
      senderRecipientDomains: { 'mb-open': ['outlook.com'], 'mb-open-2': ['gmail.com'] },
    }, NO_OPEN_SENDER_ERROR);
  });

  it('refuses a pool made only of mailboxes limited by their own lists', async () => {
    await refused({ senderAccountId: 'mb-gmail', senderAccountIds: ['mb-gmail', 'mb-microsoft'] }, NO_OPEN_SENDER_ERROR);
  });

  it("counts a mailbox's own list, which the campaign cannot lift, beside the campaign's lists", async () => {
    // mb-gmail keeps its own gmail.com whatever the campaign sends for it, and the campaign limits the other.
    await refused({
      senderAccountId: 'mb-gmail',
      senderAccountIds: ['mb-gmail', 'mb-open'],
      senderRecipientDomains: { 'mb-gmail': [], 'mb-open': ['outlook.com'] },
    }, NO_OPEN_SENDER_ERROR);

    const res = await update({ senderAccountId: 'mb-gmail', senderAccountIds: ['mb-gmail', 'mb-open'] });
    expect(res.status).toBe(200);
  });

  it('refuses a new primary sender limited by its own list while the campaign has no pool for the rest', async () => {
    // No stored pool: the primary sender is the one mailbox the campaign sends from.
    await refused({ senderAccountId: 'mb-gmail' }, NO_OPEN_SENDER_ERROR);
  });

  it('refuses a list for a mailbox outside the pool, and one that is no list of domain names', async () => {
    await refused(
      { senderAccountIds: ['mb-open'], senderRecipientDomains: { 'mb-open-2': ['gmail.com'] } },
      "Recipient Domains were sent for a mailbox that is not in the campaign's sender pool.",
    );
    await refused(
      { senderAccountIds: ['mb-open', 'mb-open-2'], senderRecipientDomains: { 'mb-open-2': ['gmail'] } },
      '"gmail" is not a domain name. Enter Recipient Domains such as gmail.com.',
    );
  });

  it('reads no pool and checks nothing for a save with no sender fields', async () => {
    const res = await update({ name: 'Renamed' });
    expect(res.status).toBe(200);
    expect(mockedPrisma.campaignSenderAccount.findMany).not.toHaveBeenCalled();
    expect(mockedPrisma.senderAccount.findMany).not.toHaveBeenCalled();
    expect(tx.campaignSenderAccount.deleteMany).not.toHaveBeenCalled();
  });
});

describe('POST /api/campaigns Recipient Domains', () => {
  beforeEach(() => {
    mockedDb.createCampaign.mockImplementation(async (data: any) => ({ id: 'cmp-new', ...data }));
    mockedPrisma.lead.findMany.mockResolvedValue([]);
  });

  const create = (body: Record<string, unknown>) => postCampaign(makeReq('POST', '/api/campaigns', { name: 'Win-Back', ...body }));

  it('refuses a new campaign whose mailboxes are all limited by their own lists', async () => {
    for (const body of [
      { senderAccountId: 'mb-gmail' },
      { senderAccountId: 'mb-gmail', senderAccountIds: ['mb-gmail', 'mb-microsoft'] },
    ]) {
      const res = await create(body);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe(NO_OPEN_SENDER_ERROR);
    }
    expect(mockedDb.createCampaign).not.toHaveBeenCalled();
  });

  it('creates one that has a mailbox with no list', async () => {
    const res = await create({ senderAccountId: 'mb-gmail', senderAccountIds: ['mb-gmail', 'mb-open'] });
    expect(res.status).toBe(200);
    expect(mockedDb.createCampaign).toHaveBeenCalledTimes(1);
  });
});

describe("PUT /api/accounts a mailbox's own Recipient Domains", () => {
  type CampaignRow = { name: string; userId: string; status: string; senderAccountId: string; pool: Array<{ senderAccountId: string; recipientDomains: string[] }> };
  /** The campaigns the in-use query runs against. */
  let campaigns: CampaignRow[];

  beforeEach(() => {
    campaigns = [];
    mockedDb.getAccounts.mockImplementation(async () => mailboxes.map((m) => ({ id: m.id })));
    mockedDb.updateAccount.mockImplementation(async (id: string, updates: any) => ({ ...mailbox(id), dailyLimit: 500, warmupEnabled: false, ...updates }));
    mockedPrisma.senderAccount.findUnique.mockImplementation(async ({ where }: any) => ({ ...mailbox(where.id), warmupEnabled: false }));
    mockedPrisma.campaign.findMany.mockImplementation(async ({ where, orderBy }: any) => {
      expect(where.status).toEqual({ not: 'Stopped' });
      expect(orderBy).toEqual({ name: 'asc' });
      const [{ senderAccountId: primaryId }, { senders: { some: { senderAccountId: poolId } } }] = where.OR;
      return campaigns
        .filter((c) => c.status !== 'Stopped' && (c.senderAccountId === primaryId || c.pool.some((row) => row.senderAccountId === poolId)))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((c) => ({
          name: c.name,
          userId: c.userId,
          senderAccount: { ...mailbox(c.senderAccountId) },
          senders: c.pool.map((row) => ({ recipientDomains: row.recipientDomains, senderAccount: { ...mailbox(row.senderAccountId) } })),
        }));
    });
  });

  const save = (body: Record<string, unknown>) => putAccount(makeReq('PUT', '/api/accounts', body));
  const pool = (...rows: Array<[string, string[]]>) => rows.map(([senderAccountId, recipientDomains]) => ({ senderAccountId, recipientDomains }));

  it('saves the list in its stored form and answers with it', async () => {
    const res = await save({ id: 'mb-open', recipientDomains: ['Gmail.com', '@googlemail.com', 'gmail.com'] });
    expect(res.status).toBe(200);
    expect(mockedDb.updateAccount).toHaveBeenCalledWith('mb-open', { recipientDomains: ['gmail.com', 'googlemail.com'] });
    expect((await res.json()).recipientDomains).toEqual(['gmail.com', 'googlemail.com']);
  });

  it('refuses a list that is no list of domain names, saving nothing', async () => {
    for (const [recipientDomains, error] of [
      [['gmail'], '"gmail" is not a domain name. Enter Recipient Domains such as gmail.com.'],
      ['gmail.com', 'Recipient Domains must be a list of domain names.'],
      [null, 'Recipient Domains must be a list of domain names.'],
    ] as const) {
      const res = await save({ id: 'mb-open', recipientDomains });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe(error);
    }
    expect(mockedDb.updateAccount).not.toHaveBeenCalled();
  });

  it('refuses a list that would leave a campaign with no mailbox for leads at other domains, naming it', async () => {
    campaigns = [
      // Its one other mailbox is limited by the campaign, so mb-open is the only one for the rest.
      { name: 'Win-Back', userId: 'user-1', status: 'Active', senderAccountId: 'mb-open', pool: pool(['mb-open', []], ['mb-open-2', ['outlook.com']]) },
      // No pool: mb-open stands in as the primary sender.
      { name: 'Trial', userId: 'user-1', status: 'Draft', senderAccountId: 'mb-open', pool: [] },
      // Has another mailbox with no list, so it is not held against the save.
      { name: 'Newsletter', userId: 'user-1', status: 'Active', senderAccountId: 'mb-open', pool: pool(['mb-open', []], ['mb-open-2', []]) },
    ];
    const res = await save({ id: 'mb-open', recipientDomains: ['gmail.com'] });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(
      'Cannot limit this mailbox to Recipient Domains: 2 campaigns would be left with no mailbox for leads at other domains: "Trial", "Win-Back". ' +
      'Add a mailbox with no Recipient Domains to those campaigns first.',
    );
    expect(mockedDb.updateAccount).not.toHaveBeenCalled();
  });

  it('saves the list while each campaign that sends from the mailbox keeps another with no list', async () => {
    campaigns = [{ name: 'Newsletter', userId: 'user-1', status: 'Active', senderAccountId: 'mb-open-2', pool: pool(['mb-open', []], ['mb-open-2', []]) }];
    const res = await save({ id: 'mb-open', recipientDomains: ['gmail.com'] });
    expect(res.status).toBe(200);
    expect(mockedDb.updateAccount).toHaveBeenCalledWith('mb-open', { recipientDomains: ['gmail.com'] });
  });

  it('does not hold a Stopped campaign against the save', async () => {
    campaigns = [{ name: 'Old Outreach', userId: 'user-1', status: 'Stopped', senderAccountId: 'mb-open', pool: [] }];
    const res = await save({ id: 'mb-open', recipientDomains: ['gmail.com'] });
    expect(res.status).toBe(200);
  });

  it('clears the list without looking at the campaigns', async () => {
    const res = await save({ id: 'mb-gmail', recipientDomains: [] });
    expect(res.status).toBe(200);
    expect(mockedPrisma.campaign.findMany).not.toHaveBeenCalled();
    expect(mockedDb.updateAccount).toHaveBeenCalledWith('mb-gmail', { recipientDomains: [] });
  });

  it("refuses the list for a mailbox that is not the caller's before reading any campaign", async () => {
    mockedDb.getAccounts.mockResolvedValue([{ id: 'mb-open-2' }]);
    const res = await save({ id: 'mb-open', recipientDomains: ['gmail.com'] });
    expect(res.status).toBe(403);
    expect(mockedPrisma.campaign.findMany).not.toHaveBeenCalled();
    expect(mockedDb.updateAccount).not.toHaveBeenCalled();
  });
});
