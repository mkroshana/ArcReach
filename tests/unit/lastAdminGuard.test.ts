import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';

vi.mock('../../lib/db', () => ({
  db: {
    updateUserRole: vi.fn(),
    updateUserPassword: vi.fn(),
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
import { PUT as putUser, DELETE as deleteUser } from '../../app/api/users/route';

const mockedDb = db as any;
const mockedPrisma = prisma as any;
const mockedSession = vi.mocked(getSession);

const ADMIN = { id: 'admin-1', name: 'Admin', email: 'admin@example.com', role: 'ADMIN' as const };
const TX_OPTIONS = { isolationLevel: 'Serializable', maxWait: 10_000, timeout: 60_000 };

/** The client handed to the $transaction callback, kept distinct from `prisma` so tests can tell them apart. */
const tx = { user: mockedPrisma.user };

/** The User table the guard reads, reset before each test. */
let users: { id: string; role: 'ADMIN' | 'USER' }[];

function makePut(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/users', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
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
  ];
  mockedSession.mockResolvedValue(ADMIN);
  mockedPrisma.$transaction.mockImplementation(async (fn: any) => fn(tx));
  mockedPrisma.user.findUnique.mockImplementation(async ({ where }: any) => {
    const u = users.find((x) => x.id === where.id);
    return u ? { role: u.role } : null;
  });
  mockedPrisma.user.count.mockImplementation(async ({ where }: any) => users.filter((x) => x.role === where.role).length);
  mockedDb.updateUserRole.mockImplementation(async (id: string, role: string) => ({ id, role }));
  mockedDb.updateUserPassword.mockImplementation(async (id: string) => ({ id }));
  mockedDb.deleteUser.mockImplementation(async (id: string) => ({ id }));
  // No one owns mailboxes or campaigns here; the ownership guard is covered in userDeleteOwnership.test.ts.
  mockedPrisma.senderAccount.count.mockResolvedValue(0);
  mockedPrisma.campaign.count.mockResolvedValue(0);
});

describe('PUT /api/users (L12)', () => {
  it('refuses to let an admin demote themselves, even when other admins exist', async () => {
    const res = await putUser(makePut({ id: 'admin-1', role: 'USER' }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('cannot remove your own admin role');
    expect(mockedDb.updateUserRole).not.toHaveBeenCalled();
  });

  it('refuses to demote the last remaining admin and writes nothing', async () => {
    users = [
      { id: 'admin-1', role: 'USER' },
      { id: 'admin-2', role: 'ADMIN' },
    ];
    const res = await putUser(makePut({ id: 'admin-2', role: 'USER', password: 'new-password-123' }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('Cannot demote the last remaining admin. Promote another user to admin first.');
    expect(mockedDb.updateUserRole).not.toHaveBeenCalled();
    expect(mockedDb.updateUserPassword).not.toHaveBeenCalled();
  });

  it('demotes another admin inside a serializable transaction when one would remain', async () => {
    const res = await putUser(makePut({ id: 'admin-2', role: 'USER' }));
    expect(res.status).toBe(200);
    expect(mockedPrisma.$transaction).toHaveBeenCalledWith(expect.any(Function), TX_OPTIONS);
    expect(mockedDb.updateUserRole).toHaveBeenCalledWith('admin-2', 'USER', tx);
  });

  it('returns 409 with a retry message when the serializable transaction hits a write conflict', async () => {
    mockedPrisma.$transaction.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Transaction failed due to a write conflict', { code: 'P2034', clientVersion: 'test' }),
    );
    const res = await putUser(makePut({ id: 'admin-2', role: 'USER' }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('Another change to admin roles happened at the same time. Please retry.');
  });

  it('promotes a user without the last-admin check', async () => {
    const res = await putUser(makePut({ id: 'user-1', role: 'ADMIN' }));
    expect(res.status).toBe(200);
    expect(mockedPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockedDb.updateUserRole).toHaveBeenCalledWith('user-1', 'ADMIN');
  });

  it('lets an admin reset their own password', async () => {
    const res = await putUser(makePut({ id: 'admin-1', password: 'new-password-123' }));
    expect(res.status).toBe(200);
    expect(mockedDb.updateUserPassword).toHaveBeenCalledWith('admin-1', 'new-password-123');
  });
});

describe('DELETE /api/users (L12)', () => {
  it('refuses to delete the last remaining admin', async () => {
    users = [
      { id: 'admin-1', role: 'USER' },
      { id: 'admin-2', role: 'ADMIN' },
    ];
    const res = await deleteUser(makeDelete('admin-2'));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('Cannot delete the last remaining admin. Promote another user to admin first.');
    expect(mockedDb.deleteUser).not.toHaveBeenCalled();
  });

  it('deletes another admin inside a serializable transaction with a raised timeout when one would remain', async () => {
    const res = await deleteUser(makeDelete('admin-2'));
    expect(res.status).toBe(200);
    expect(mockedPrisma.$transaction).toHaveBeenCalledWith(expect.any(Function), TX_OPTIONS);
    expect(mockedDb.deleteUser).toHaveBeenCalledWith('admin-2', tx);
  });

  it('deletes a non-admin user directly, without opening a transaction, even when only one admin exists', async () => {
    users = [
      { id: 'admin-1', role: 'ADMIN' },
      { id: 'user-1', role: 'USER' },
    ];
    const res = await deleteUser(makeDelete('user-1'));
    expect(res.status).toBe(200);
    expect(mockedPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockedDb.deleteUser).toHaveBeenCalledWith('user-1', mockedPrisma);
  });

  it('no longer special-cases the dev seed admin id', async () => {
    users.push({ id: 'admin-id-999', role: 'ADMIN' });
    const res = await deleteUser(makeDelete('admin-id-999'));
    expect(res.status).toBe(200);
    expect(mockedDb.deleteUser).toHaveBeenCalledWith('admin-id-999', tx);
  });

  it('still refuses to delete the caller', async () => {
    const res = await deleteUser(makeDelete('admin-1'));
    expect(res.status).toBe(400);
    expect(mockedDb.deleteUser).not.toHaveBeenCalled();
  });
});
