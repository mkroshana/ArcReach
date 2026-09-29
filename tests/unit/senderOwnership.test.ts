import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const tx = vi.hoisted(() => ({
  campaign: { update: vi.fn() },
  campaignSenderAccount: { deleteMany: vi.fn(), createMany: vi.fn() },
  campaignStep: { deleteMany: vi.fn(), createMany: vi.fn() },
  lead: { findMany: vi.fn() },
  campaignEnrollment: { findMany: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn() },
}));

vi.mock('../../lib/db', () => ({
  db: {
    createCampaign: vi.fn(),
  },
  prisma: {
    senderAccount: { findMany: vi.fn() },
    campaign: { findUnique: vi.fn() },
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
import { POST as postCampaign } from '../../app/api/campaigns/route';
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

describe('PUT /api/campaigns/[id] sender ownership (H24)', () => {
  const CAMPAIGN = { id: 'cmp-1', userId: 'user-1', audienceCohort: 'Valid', senderAccountId: 'mb-user1-a' };

  beforeEach(() => {
    mockedSession.mockResolvedValue(USER);
    mockedPrisma.campaign.findUnique.mockResolvedValue(CAMPAIGN);
    mockedPrisma.$transaction.mockImplementation(async (fn: any) => fn(tx));
    tx.lead.findMany.mockResolvedValue([]);
    tx.campaignEnrollment.findMany.mockResolvedValue([]);
  });

  const update = (body: Record<string, unknown>) =>
    putCampaignDetail(makeReq('PUT', '/api/campaigns/cmp-1', body), { params: Promise.resolve({ id: 'cmp-1' }) });

  it('saves a sender pool made of the owner\'s mailboxes', async () => {
    const res = await update({ senderAccountId: 'mb-user1-b', senderAccountIds: ['mb-user1-a', 'mb-user1-b'] });
    expect(res.status).toBe(200);
    expect(tx.campaign.update).toHaveBeenCalledWith({ where: { id: 'cmp-1' }, data: { senderAccountId: 'mb-user1-b' } });
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
