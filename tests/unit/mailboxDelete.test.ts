import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';

vi.mock('../../lib/db', () => ({
  db: {
    getAccounts: vi.fn(),
    deleteAccount: vi.fn(),
  },
  prisma: {
    campaign: { findMany: vi.fn() },
  },
}));

vi.mock('../../lib/session', () => ({
  getSession: vi.fn(),
}));

import { db, prisma } from '../../lib/db';
import { getSession } from '../../lib/session';
import { DELETE as deleteAccount } from '../../app/api/accounts/route';

const mockedDb = db as any;
const mockedPrisma = prisma as any;
const mockedSession = vi.mocked(getSession);

const USER = { id: 'user-1', name: 'User', email: 'user@example.com', role: 'USER' as const };
const ADMIN = { id: 'admin-1', name: 'Admin', email: 'admin@example.com', role: 'ADMIN' as const };

type CampaignRow = { name: string; userId: string; senderAccountId: string; pool: string[] };

/** The Campaign table (with each campaign's sender pool) the dependency query runs against. */
let campaigns: CampaignRow[];

/** Evaluates the route's `OR: [primary sender, sender pool]` filter against `campaigns`. */
function matches(c: CampaignRow, cond: any): boolean {
  if (cond.senderAccountId !== undefined) return c.senderAccountId === cond.senderAccountId;
  if (cond.senders?.some?.senderAccountId !== undefined) return c.pool.includes(cond.senders.some.senderAccountId);
  throw new Error(`Unexpected campaign filter: ${JSON.stringify(cond)}`);
}

function makeDelete(id: string): NextRequest {
  return new NextRequest(`http://localhost/api/accounts?id=${id}`, { method: 'DELETE' });
}

beforeEach(() => {
  vi.clearAllMocks();
  campaigns = [];
  mockedSession.mockResolvedValue(USER);
  mockedDb.getAccounts.mockResolvedValue([{ id: 'mb-1' }, { id: 'mb-2' }]);
  mockedDb.deleteAccount.mockResolvedValue({ id: 'mb-1' });
  mockedPrisma.campaign.findMany.mockImplementation(async ({ where, select, orderBy }: any) => {
    expect(select).toEqual({ name: true, userId: true });
    expect(orderBy).toEqual({ name: 'asc' });
    return campaigns
      .filter((c) => where.OR.some((cond: any) => matches(c, cond)))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(({ name, userId }) => ({ name, userId }));
  });
});

describe('DELETE /api/accounts in-use guard (C3)', () => {
  it('refuses with 409 and deletes nothing while a campaign uses the mailbox as primary sender', async () => {
    campaigns = [{ name: 'Q3 Outreach', userId: 'user-1', senderAccountId: 'mb-1', pool: [] }];
    const res = await deleteAccount(makeDelete('mb-1'));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(
      'Cannot delete this mailbox while a campaign uses it as a sender: "Q3 Outreach". Switch that campaign to another mailbox or delete it first.',
    );
    expect(mockedDb.deleteAccount).not.toHaveBeenCalled();
  });

  it('refuses while the mailbox is only in a campaign sender pool', async () => {
    campaigns = [
      { name: 'Rotation', userId: 'user-1', senderAccountId: 'mb-2', pool: ['mb-2', 'mb-1'] },
      { name: 'Unrelated', userId: 'user-1', senderAccountId: 'mb-2', pool: ['mb-2'] },
    ];
    const res = await deleteAccount(makeDelete('mb-1'));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('"Rotation"');
    expect(mockedDb.deleteAccount).not.toHaveBeenCalled();
  });

  it('names at most five campaigns and counts the rest', async () => {
    campaigns = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((name) => ({ name, userId: 'user-1', senderAccountId: 'mb-1', pool: [] }));
    const res = await deleteAccount(makeDelete('mb-1'));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(
      'Cannot delete this mailbox while 7 campaigns use it as a sender: "A", "B", "C", "D", "E" and 2 more. Switch those campaigns to another mailbox or delete them first.',
    );
  });

  it('only counts, never names, other users\' campaigns for a non-admin', async () => {
    campaigns = [
      { name: 'Mine', userId: 'user-1', senderAccountId: 'mb-1', pool: [] },
      { name: 'Secret Plan', userId: 'user-2', senderAccountId: 'mb-1', pool: [] },
    ];
    const res = await deleteAccount(makeDelete('mb-1'));
    expect(res.status).toBe(409);
    const { error } = await res.json();
    expect(error).toBe(
      'Cannot delete this mailbox while 2 campaigns use it as a sender: "Mine" and 1 more. Switch those campaigns to another mailbox or delete them first.',
    );
    expect(error).not.toContain('Secret Plan');
  });

  it('names every user\'s campaigns for an admin', async () => {
    mockedSession.mockResolvedValue(ADMIN);
    campaigns = [
      { name: 'Mine', userId: 'user-1', senderAccountId: 'mb-1', pool: [] },
      { name: 'Theirs', userId: 'user-2', senderAccountId: 'mb-3', pool: ['mb-1'] },
    ];
    const res = await deleteAccount(makeDelete('mb-1'));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('"Mine", "Theirs"');
  });

  it('deletes the mailbox once no campaign uses it', async () => {
    campaigns = [{ name: 'Other Sender', userId: 'user-1', senderAccountId: 'mb-2', pool: ['mb-2'] }];
    const res = await deleteAccount(makeDelete('mb-1'));
    expect(res.status).toBe(200);
    expect(mockedDb.deleteAccount).toHaveBeenCalledWith('mb-1');
  });

  it('returns 409 when the Restrict foreign key refuses a delete that raced a new campaign', async () => {
    mockedDb.deleteAccount.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Foreign key constraint violated', { code: 'P2003', clientVersion: 'test' }),
    );
    const res = await deleteAccount(makeDelete('mb-1'));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(
      'Cannot delete this mailbox while a campaign uses it as a sender. Switch that campaign to another mailbox or delete it first.',
    );
  });

  it('still refuses a mailbox the caller does not own before looking up campaigns', async () => {
    const res = await deleteAccount(makeDelete('mb-other'));
    expect(res.status).toBe(403);
    expect(mockedPrisma.campaign.findMany).not.toHaveBeenCalled();
    expect(mockedDb.deleteAccount).not.toHaveBeenCalled();
  });
});
