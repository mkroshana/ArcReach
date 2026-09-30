import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const tx = vi.hoisted(() => ({
  campaign: { updateMany: vi.fn() },
  campaignSenderAccount: { deleteMany: vi.fn(), createMany: vi.fn() },
  campaignStep: { deleteMany: vi.fn(), createMany: vi.fn() },
  lead: { findMany: vi.fn() },
  campaignEnrollment: { count: vi.fn(), findMany: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn() },
}));

vi.mock('../../lib/db', () => ({
  db: {
    createCampaign: vi.fn(),
    updateCampaign: vi.fn(),
  },
  prisma: {
    senderAccount: { findMany: vi.fn() },
    user: { findUnique: vi.fn() },
    campaign: { findUnique: vi.fn(), findFirst: vi.fn() },
    lead: { findMany: vi.fn() },
    campaignEnrollment: { createMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock('../../lib/session', () => ({
  getSession: vi.fn(),
}));

import { db, prisma } from '../../lib/db';
import { getSession } from '../../lib/session';
import { POST as postCampaign, PUT as putCampaigns } from '../../app/api/campaigns/route';
import { PUT as putCampaignDetail } from '../../app/api/campaigns/[id]/route';

const mockedDb = db as any;
const mockedPrisma = prisma as any;
const mockedSession = vi.mocked(getSession);

const USER = { id: 'user-1', name: 'User', email: 'user@example.com', role: 'USER' as const };
const ADMIN = { id: 'admin-1', name: 'Admin', email: 'admin@example.com', role: 'ADMIN' as const };

/** The SenderAccount table the ownership query runs against. */
const MAILBOXES = [
  { id: 'mb-user1-a', userId: 'user-1' },
  { id: 'mb-user1-b', userId: 'user-1' },
  { id: 'mb-user2', userId: 'user-2' },
  { id: 'mb-admin', userId: 'admin-1' },
];

function makeReq(method: string, path: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedPrisma.senderAccount.findMany.mockImplementation(async ({ where }: any) =>
    MAILBOXES.filter((m) => where.id.in.includes(m.id) && m.userId === where.userId).map((m) => ({ id: m.id })),
  );
});

describe('POST /api/campaigns sender ownership (H24)', () => {
  beforeEach(() => {
    mockedSession.mockResolvedValue(USER);
    mockedDb.createCampaign.mockImplementation(async (data: any) => ({ id: 'cmp-new', ...data }));
    mockedPrisma.lead.findMany.mockResolvedValue([]);
  });

  const create = (body: Record<string, unknown>) =>
    postCampaign(makeReq('POST', '/api/campaigns', { name: 'Outreach', ...body }));

  it('creates a campaign from the owner\'s own mailboxes', async () => {
    const res = await create({ senderAccountId: 'mb-user1-a', senderAccountIds: ['mb-user1-a', 'mb-user1-b'] });
    expect(res.status).toBe(200);
    expect(mockedPrisma.senderAccount.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['mb-user1-a', 'mb-user1-b'] }, userId: 'user-1' },
      select: { id: true },
    });
    const [data] = mockedDb.createCampaign.mock.calls[0];
    expect(data.userId).toBe('user-1');
    expect(data.senderAccountId).toBe('mb-user1-a');
  });

  it('rejects another user\'s mailbox as the primary sender or in the pool', async () => {
    const primary = await create({ senderAccountId: 'mb-user2' });
    expect(primary.status).toBe(403);
    expect((await primary.json()).error).toBe('Sender mailbox does not belong to the campaign owner: mb-user2.');

    const pool = await create({ senderAccountId: 'mb-user1-a', senderAccountIds: ['mb-user1-a', 'mb-user2', 'mb-admin'] });
    expect(pool.status).toBe(403);
    expect((await pool.json()).error).toBe('Sender mailbox does not belong to the campaign owner: mb-user2, mb-admin.');

    expect(mockedDb.createCampaign).not.toHaveBeenCalled();
  });

  it('rejects unknown mailbox IDs the same way', async () => {
    const res = await create({ senderAccountId: 'mb-missing' });
    expect(res.status).toBe(403);
    expect(mockedDb.createCampaign).not.toHaveBeenCalled();
  });

  it('holds an ADMIN to the chosen owner\'s mailboxes, not their own', async () => {
    mockedSession.mockResolvedValue(ADMIN);

    const ownMailbox = await create({ userId: 'user-2', senderAccountId: 'mb-admin' });
    expect(ownMailbox.status).toBe(403);

    const noOwner = await create({ senderAccountId: 'mb-user2' });
    expect(noOwner.status).toBe(403);
    expect(mockedDb.createCampaign).not.toHaveBeenCalled();

    const ok = await create({ userId: 'user-2', senderAccountId: 'mb-user2', senderAccountIds: ['mb-user2'] });
    expect(ok.status).toBe(200);
    expect(mockedDb.createCampaign.mock.calls[0][0].userId).toBe('user-2');
  });

  it('ignores a USER-supplied userId when checking ownership', async () => {
    const res = await create({ userId: 'user-2', senderAccountId: 'mb-user2' });
    expect(res.status).toBe(403);
    expect(mockedDb.createCampaign).not.toHaveBeenCalled();
  });

  it('rejects non-string sender and owner IDs before querying', async () => {
    for (const body of [
      { senderAccountId: { not: 'x' } },
      { senderAccountId: 'mb-user1-a', senderAccountIds: [{ not: 'x' }] },
      { senderAccountId: 'mb-user1-a', senderAccountIds: [''] },
    ]) {
      const res = await create(body);
      expect(res.status).toBe(400);
    }
    mockedSession.mockResolvedValue(ADMIN);
    const owner = await create({ userId: { not: 'x' }, senderAccountId: 'mb-user2' });
    expect(owner.status).toBe(400);

    expect(mockedPrisma.senderAccount.findMany).not.toHaveBeenCalled();
    expect(mockedDb.createCampaign).not.toHaveBeenCalled();
  });
});

/** The version a save from the campaign page names: the stored one. */
const UPDATED_AT = new Date('2026-09-01T10:00:00.000Z');

describe('PUT /api/campaigns/[id] sender ownership (H24)', () => {
  const CAMPAIGN = { id: 'cmp-1', userId: 'user-1', audienceCohort: 'Valid', senderAccountId: 'mb-user1-a', updatedAt: UPDATED_AT };

  beforeEach(() => {
    mockedSession.mockResolvedValue(USER);
    mockedPrisma.campaign.findUnique.mockResolvedValue(CAMPAIGN);
    mockedPrisma.$transaction.mockImplementation(async (fn: any) => fn(tx));
    tx.campaign.updateMany.mockResolvedValue({ count: 1 });
    tx.lead.findMany.mockResolvedValue([]);
    tx.campaignEnrollment.count.mockResolvedValue(0);
    tx.campaignEnrollment.findMany.mockResolvedValue([]);
  });

  const update = (body: Record<string, unknown>) =>
    putCampaignDetail(makeReq('PUT', '/api/campaigns/cmp-1', { updatedAt: UPDATED_AT.toISOString(), ...body }), { params: Promise.resolve({ id: 'cmp-1' }) });

  it('saves a sender pool made of the owner\'s mailboxes', async () => {
    const res = await update({ senderAccountId: 'mb-user1-b', senderAccountIds: ['mb-user1-a', 'mb-user1-b'] });
    expect(res.status).toBe(200);
    expect(tx.campaign.updateMany).toHaveBeenCalledWith({
      where: { id: 'cmp-1', updatedAt: UPDATED_AT },
      data: { senderAccountId: 'mb-user1-b', updatedAt: expect.any(Date) },
    });
    expect(tx.campaignSenderAccount.createMany).toHaveBeenCalledWith({
      data: [
        { campaignId: 'cmp-1', senderAccountId: 'mb-user1-a' },
        { campaignId: 'cmp-1', senderAccountId: 'mb-user1-b' },
      ],
    });
  });

  it('rejects another user\'s mailbox as the primary sender or in the pool', async () => {
    const primary = await update({ senderAccountId: 'mb-user2' });
    expect(primary.status).toBe(403);
    expect((await primary.json()).error).toBe('Sender mailbox does not belong to the campaign owner: mb-user2.');

    const pool = await update({ senderAccountId: 'mb-user1-a', senderAccountIds: ['mb-user1-a', 'mb-user2'] });
    expect(pool.status).toBe(403);

    expect(mockedPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('holds an ADMIN to the campaign owner\'s mailboxes', async () => {
    mockedSession.mockResolvedValue(ADMIN);

    const adminMailbox = await update({ senderAccountIds: ['mb-admin'] });
    expect(adminMailbox.status).toBe(403);
    expect(mockedPrisma.senderAccount.findMany).toHaveBeenLastCalledWith({
      where: { id: { in: ['mb-admin'] }, userId: 'user-1' },
      select: { id: true },
    });
    expect(mockedPrisma.$transaction).not.toHaveBeenCalled();

    const ownerMailbox = await update({ senderAccountIds: ['mb-user1-b'] });
    expect(ownerMailbox.status).toBe(200);
    expect(tx.campaignSenderAccount.createMany).toHaveBeenCalledWith({
      data: [{ campaignId: 'cmp-1', senderAccountId: 'mb-user1-b' }],
    });
  });

  it('skips the check when no sender fields are sent', async () => {
    const res = await update({ name: 'Renamed' });
    expect(res.status).toBe(200);
    expect(mockedPrisma.senderAccount.findMany).not.toHaveBeenCalled();
    expect(tx.campaignSenderAccount.deleteMany).not.toHaveBeenCalled();
  });

  it('rejects non-string sender IDs', async () => {
    for (const body of [
      { senderAccountId: null },
      { senderAccountId: { not: 'x' } },
      { senderAccountIds: ['mb-user1-a', 5] },
    ]) {
      const res = await update(body);
      expect(res.status).toBe(400);
    }
    expect(mockedPrisma.senderAccount.findMany).not.toHaveBeenCalled();
    expect(mockedPrisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('reassigning a campaign keeps its senders with its owner (H24)', () => {
  const USERS = ['user-1', 'user-2', 'admin-1'];
  const mailbox = (id: string) => ({ id, emailAddress: `${id}@acme.test` });
  /** A campaign row as PUT /api/campaigns loads it: owner user-1, sending from user-1's mailboxes. */
  let campaign: any;

  beforeEach(() => {
    mockedSession.mockResolvedValue(ADMIN);
    campaign = {
      id: 'cmp-1', userId: 'user-1', status: 'Draft', steps: [],
      senderAccountId: 'mb-user1-a', senderAccount: mailbox('mb-user1-a'),
      senders: [
        { senderAccountId: 'mb-user1-a', senderAccount: mailbox('mb-user1-a') },
        { senderAccountId: 'mb-user1-b', senderAccount: mailbox('mb-user1-b') },
      ],
    };
    mockedPrisma.campaign.findFirst.mockImplementation(async () => campaign);
    mockedDb.updateCampaign.mockImplementation(async (id: string, data: any) => ({ ...campaign, ...data }));
    mockedPrisma.user.findUnique.mockImplementation(async ({ where }: any) =>
      USERS.includes(where.id) ? { id: where.id } : null,
    );
  });

  const reassign = (userId: unknown) => putCampaigns(makeReq('PUT', '/api/campaigns', { id: 'cmp-1', userId }));

  it('refuses with 409 to give an ADMIN-reassigned campaign an owner who does not own its senders', async () => {
    const res = await reassign('user-2');
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(
      "Cannot assign this campaign to that user: it sends from mb-user1-a@acme.test, mb-user1-b@acme.test, which the new owner does not own. A campaign only sends from its owner's mailboxes, so assign those mailboxes to the new owner first.",
    );
    expect(mockedPrisma.senderAccount.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['mb-user1-a', 'mb-user1-b'] }, userId: 'user-2' },
      select: { id: true },
    });
    expect(mockedDb.updateCampaign).not.toHaveBeenCalled();
  });

  it('names only the senders the new owner does not own, checking the primary sender too', async () => {
    campaign.senderAccountId = 'mb-user1-a';
    campaign.senderAccount = mailbox('mb-user1-a');
    campaign.senders = [{ senderAccountId: 'mb-user2', senderAccount: mailbox('mb-user2') }];

    const res = await reassign('user-2');
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(
      "Cannot assign this campaign to that user: it sends from mb-user1-a@acme.test, which the new owner does not own. A campaign only sends from its owner's mailboxes, so assign that mailbox to the new owner first.",
    );
    expect(mockedDb.updateCampaign).not.toHaveBeenCalled();
  });

  it('reassigns the campaign once the new owner owns every sender', async () => {
    campaign.senderAccountId = 'mb-user2';
    campaign.senderAccount = mailbox('mb-user2');
    campaign.senders = [{ senderAccountId: 'mb-user2', senderAccount: mailbox('mb-user2') }];

    const res = await reassign('user-2');
    expect(res.status).toBe(200);
    expect(mockedDb.updateCampaign).toHaveBeenCalledWith('cmp-1', { userId: 'user-2' });
  });

  it('skips the check when the owner does not change, and never checks senders for an unknown user', async () => {
    expect((await reassign('user-1')).status).toBe(200);
    expect(mockedDb.updateCampaign).toHaveBeenCalledWith('cmp-1', { userId: 'user-1' });

    expect((await reassign('user-missing')).status).toBe(400);
    expect(mockedPrisma.senderAccount.findMany).not.toHaveBeenCalled();
  });

  it('ignores a userId sent by a USER, so there is nothing to check', async () => {
    mockedSession.mockResolvedValue(USER);
    const res = await reassign('user-2');
    expect(res.status).toBe(200);
    expect(mockedDb.updateCampaign).toHaveBeenCalledWith('cmp-1', {});
    expect(mockedPrisma.senderAccount.findMany).not.toHaveBeenCalled();
  });

  it('has no owner change through PUT /api/campaigns/[id]', async () => {
    mockedPrisma.campaign.findUnique.mockResolvedValue({
      id: 'cmp-1', userId: 'user-1', audienceCohort: 'Valid', senderAccountId: 'mb-user1-a', updatedAt: UPDATED_AT,
    });
    mockedPrisma.$transaction.mockImplementation(async (fn: any) => fn(tx));
    tx.campaign.updateMany.mockResolvedValue({ count: 1 });
    tx.campaignEnrollment.count.mockResolvedValue(1);

    const body = { name: 'Renamed', userId: 'user-2', updatedAt: UPDATED_AT.toISOString() };
    const res = await putCampaignDetail(makeReq('PUT', '/api/campaigns/cmp-1', body), {
      params: Promise.resolve({ id: 'cmp-1' }),
    });
    expect(res.status).toBe(200);
    expect(tx.campaign.updateMany).toHaveBeenCalledWith({
      where: { id: 'cmp-1', updatedAt: UPDATED_AT },
      data: { name: 'Renamed', updatedAt: expect.any(Date) },
    });
  });
});
