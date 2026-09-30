import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';

vi.mock('../../lib/db', () => ({
  db: {
    deleteUser: vi.fn(),
  },
  prisma: {
    user: { findUnique: vi.fn(), count: vi.fn() },
    senderAccount: { count: vi.fn() },
    campaign: { count: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock('../../lib/session', () => ({
  getSession: vi.fn(),
}));

import { db, prisma } from '../../lib/db';
import { getSession } from '../../lib/session';
import { DELETE as deleteUser } from '../../app/api/users/route';

const mockedDb = db as any;
const mockedPrisma = prisma as any;
const mockedSession = vi.mocked(getSession);

const ADMIN = { id: 'admin-1', name: 'Admin', email: 'admin@example.com', role: 'ADMIN' as const };

/** The User, SenderAccount and Campaign tables the route reads, reset before each test. */
let users: { id: string; role: 'ADMIN' | 'USER' }[];
let mailboxes: { id: string; userId: string }[];
let campaigns: { id: string; userId: string }[];

/** Counts the rows of `table` matching the route's `{ where: { userId } }` filter. */
function countByOwner(table: () => { userId: string }[]) {
  return async ({ where }: any) => {
    expect(Object.keys(where)).toEqual(['userId']);
    return table().filter((r) => r.userId === where.userId).length;
  };
}

function makeDelete(id: string): NextRequest {
  return new NextRequest(`http://localhost/api/users?id=${id}`, { method: 'DELETE' });
}

beforeEach(() => {
  vi.clearAllMocks();
  users = [
    { id: 'admin-1', role: 'ADMIN' },
    { id: 'admin-2', role: 'ADMIN' },
    { id: 'user-1', role: 'USER' },
    { id: 'user-2', role: 'USER' },
  ];
  mailboxes = [];
  campaigns = [];
  mockedSession.mockResolvedValue(ADMIN);
  mockedPrisma.$transaction.mockImplementation(async (fn: any) => fn({ user: mockedPrisma.user }));
  mockedPrisma.user.findUnique.mockImplementation(async ({ where }: any) => {
    const u = users.find((x) => x.id === where.id);
    return u ? { role: u.role } : null;
  });
  mockedPrisma.user.count.mockImplementation(async ({ where }: any) => users.filter((x) => x.role === where.role).length);
  mockedPrisma.senderAccount.count.mockImplementation(countByOwner(() => mailboxes));
  mockedPrisma.campaign.count.mockImplementation(countByOwner(() => campaigns));
  mockedDb.deleteUser.mockImplementation(async (id: string) => ({ id }));
});

describe('DELETE /api/users ownership guard (H27)', () => {
  it('refuses with 409 and the counts, deleting nothing, while the user owns mailboxes and campaigns', async () => {
    mailboxes = [{ id: 'mb-1', userId: 'user-1' }, { id: 'mb-2', userId: 'user-1' }, { id: 'mb-3', userId: 'user-2' }];
    campaigns = [{ id: 'c-1', userId: 'user-1' }, { id: 'c-2', userId: 'user-2' }];
    const res = await deleteUser(makeDelete('user-1'));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'Cannot remove this user while they own 2 mailboxes and 1 campaign. Reassign them to another user or delete them first.',
      mailboxes: 2,
      campaigns: 1,
    });
    expect(mockedDb.deleteUser).not.toHaveBeenCalled();
  });

  it('names only campaigns when the user owns no mailboxes, in the singular for one', async () => {
    campaigns = [{ id: 'c-1', userId: 'user-1' }];
    const res = await deleteUser(makeDelete('user-1'));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(
      'Cannot remove this user while they own 1 campaign. Reassign it to another user or delete it first.',
    );
    expect(mockedDb.deleteUser).not.toHaveBeenCalled();
  });

  it('names only mailboxes when the user owns no campaigns', async () => {
    mailboxes = [{ id: 'mb-1', userId: 'user-1' }, { id: 'mb-2', userId: 'user-1' }];
    const res = await deleteUser(makeDelete('user-1'));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(
      'Cannot remove this user while they own 2 mailboxes. Reassign them to another user or delete them first.',
    );
    expect(mockedDb.deleteUser).not.toHaveBeenCalled();
  });

  it('refuses an admin who owns work before opening the last-admin transaction', async () => {
    mailboxes = [{ id: 'mb-1', userId: 'admin-2' }];
    const res = await deleteUser(makeDelete('admin-2'));
    expect(res.status).toBe(409);
    expect((await res.json()).mailboxes).toBe(1);
    expect(mockedPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockedDb.deleteUser).not.toHaveBeenCalled();
  });

  it('deletes a user who owns nothing, even when other users own mailboxes and campaigns', async () => {
    mailboxes = [{ id: 'mb-1', userId: 'user-2' }];
    campaigns = [{ id: 'c-1', userId: 'user-2' }];
    const res = await deleteUser(makeDelete('user-1'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(mockedDb.deleteUser).toHaveBeenCalledWith('user-1', mockedPrisma);
  });

  it('returns 409 when the Restrict foreign key refuses the delete after the check passed', async () => {
    mockedDb.deleteUser.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Foreign key constraint violated', { code: 'P2003', clientVersion: 'test' }),
    );
    const res = await deleteUser(makeDelete('user-1'));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(
      'Cannot remove this user while they own mailboxes or campaigns. Reassign them to another user or delete them first.',
    );
  });

  it('still returns 500 for other database errors', async () => {
    mockedDb.deleteUser.mockRejectedValueOnce(new Error('connection lost'));
    const res = await deleteUser(makeDelete('user-1'));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('connection lost');
  });
});
