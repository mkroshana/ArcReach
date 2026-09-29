import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';

/**
 * The real lib/db and /api/users run against this fake client, so the tests see the exact
 * writes the helpers make: the tokenVersion bumps and the disabledAt flag.
 */
const fake = vi.hoisted(() => ({
  user: { findUnique: vi.fn(), findMany: vi.fn(), count: vi.fn(), update: vi.fn() },
  senderAccount: { count: vi.fn() },
  campaign: { count: vi.fn() },
  $transaction: vi.fn(),
}));

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
  setSession: vi.fn(),
}));

import { getSession, setSession } from '../../lib/session';
import { GET as getUsers, PUT as putUser } from '../../app/api/users/route';

const mockedSession = vi.mocked(getSession);
const mockedSetSession = vi.mocked(setSession);

const ADMIN = { id: 'admin-1', name: 'Admin', email: 'admin@example.com', role: 'ADMIN' as const };
const TX_OPTIONS = { isolationLevel: 'Serializable', maxWait: 10_000, timeout: 60_000 };

type Row = { id: string; email: string; role: 'ADMIN' | 'USER'; tokenVersion: number; disabledAt: Date | null };

/** The User table the fake client reads and writes, reset before each test. */
let users: Row[];

function pick(row: Row, select?: Record<string, boolean>) {
  return select ? Object.fromEntries(Object.keys(select).map((k) => [k, (row as any)[k]])) : { ...row };
}

function makePut(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/users', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** The `data` of the one user.update the request made. */
function writtenData() {
  expect(fake.user.update).toHaveBeenCalledTimes(1);
  return fake.user.update.mock.calls[0][0].data;
}

beforeEach(() => {
  vi.clearAllMocks();
  users = [
    { id: 'admin-1', email: 'admin@example.com', role: 'ADMIN', tokenVersion: 0, disabledAt: null },
    { id: 'admin-2', email: 'second@example.com', role: 'ADMIN', tokenVersion: 0, disabledAt: null },
    { id: 'user-1', email: 'user@example.com', role: 'USER', tokenVersion: 2, disabledAt: null },
  ];
  mockedSession.mockResolvedValue(ADMIN);
  fake.$transaction.mockImplementation(async (fn: any) => fn(fake));
  fake.user.findUnique.mockImplementation(async ({ where, select }: any) => {
    // lib/db's dev seeding looks the seed users up by email; report them present so it writes nothing.
    if (where.email) return { id: 'seed' };
    const row = users.find((u) => u.id === where.id);
    return row ? pick(row, select) : null;
  });
  fake.user.findMany.mockImplementation(async ({ select }: any) => users.map((u) => pick(u, select)));
  fake.user.count.mockImplementation(async ({ where }: any) =>
    users.filter((u) => u.role === where.role && (where.disabledAt !== null || u.disabledAt === null)).length);
  fake.user.update.mockImplementation(async ({ where, data, select }: any) => {
    const row = users.find((u) => u.id === where.id);
    if (!row) throw new Prisma.PrismaClientKnownRequestError('Record to update not found.', { code: 'P2025', clientVersion: 'test' });
    for (const [key, value] of Object.entries(data)) {
      (row as any)[key] = value && typeof value === 'object' && 'increment' in value ? (row as any)[key] + (value as any).increment : value;
    }
    return pick(row, select);
  });
  fake.senderAccount.count.mockResolvedValue(0);
  fake.campaign.count.mockResolvedValue(0);
});

describe('PUT /api/users disable and enable (H26)', () => {
  it('disables a user at once: stamps disabledAt and bumps tokenVersion to end their sessions', async () => {
    const res = await putUser(makePut({ id: 'user-1', disabled: true }));

    expect(res.status).toBe(200);
    const data = writtenData();
    expect(data.disabledAt).toBeInstanceOf(Date);
    expect(data.tokenVersion).toEqual({ increment: 1 });
    expect(users[2].tokenVersion).toBe(3);
    expect((await res.json()).disabledAt).toBeTruthy();
  });

  it('re-enables a user without touching tokenVersion, so sessions from before the disable stay dead', async () => {
    users[2].disabledAt = new Date();
    users[2].tokenVersion = 3;

    const res = await putUser(makePut({ id: 'user-1', disabled: false }));

    expect(res.status).toBe(200);
    expect(writtenData()).toEqual({ disabledAt: null });
    expect(users[2]).toMatchObject({ disabledAt: null, tokenVersion: 3 });
  });

  it('refuses to let an admin disable themselves', async () => {
    const res = await putUser(makePut({ id: 'admin-1', disabled: true }));

    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('You cannot disable your own account. Ask another admin to do it.');
    expect(fake.user.update).not.toHaveBeenCalled();
  });

  it('refuses a disabled flag that is not a boolean', async () => {
    const res = await putUser(makePut({ id: 'user-1', disabled: 'yes' }));

    expect(res.status).toBe(400);
    expect(fake.user.update).not.toHaveBeenCalled();
  });

  it('disables another admin inside the serializable last-admin transaction', async () => {
    const res = await putUser(makePut({ id: 'admin-2', disabled: true }));

    expect(res.status).toBe(200);
    expect(fake.$transaction).toHaveBeenCalledWith(expect.any(Function), TX_OPTIONS);
    expect(users[1].disabledAt).toBeInstanceOf(Date);
  });

  it('refuses to disable the last active admin, not counting disabled admins', async () => {
    users[0].role = 'USER'; // the caller, as in the demotion tests: only admin-2 and a disabled admin remain
    users.push({ id: 'admin-3', email: 'third@example.com', role: 'ADMIN', tokenVersion: 0, disabledAt: new Date() });

    const res = await putUser(makePut({ id: 'admin-2', disabled: true }));

    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('Cannot disable the last active admin. Promote another user to admin first.');
    expect(fake.user.update).not.toHaveBeenCalled();
  });

  it('does not count a disabled admin as the admin who would remain after a demotion', async () => {
    users[0].role = 'USER';
    users.push({ id: 'admin-3', email: 'third@example.com', role: 'ADMIN', tokenVersion: 0, disabledAt: new Date() });

    const res = await putUser(makePut({ id: 'admin-2', role: 'USER' }));

    expect(res.status).toBe(409);
    expect(fake.user.update).not.toHaveBeenCalled();
  });

  it('demotes a disabled admin directly, since that can not lower the active admin count', async () => {
    users[1].disabledAt = new Date();

    const res = await putUser(makePut({ id: 'admin-2', role: 'USER' }));

    expect(res.status).toBe(200);
    expect(fake.$transaction).not.toHaveBeenCalled();
    expect(users[1].role).toBe('USER');
  });

  it('returns 409 with a retry message when disabling an admin hits a write conflict', async () => {
    fake.$transaction.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Transaction failed due to a write conflict', { code: 'P2034', clientVersion: 'test' }),
    );

    const res = await putUser(makePut({ id: 'admin-2', disabled: true }));

    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('Another change to admin roles happened at the same time. Please retry.');
  });
});

describe('PUT /api/users ends sessions on role and password changes (H26)', () => {
  it('bumps tokenVersion with a role change', async () => {
    const res = await putUser(makePut({ id: 'user-1', role: 'ADMIN' }));

    expect(res.status).toBe(200);
    expect(writtenData()).toEqual({ role: 'ADMIN', tokenVersion: { increment: 1 } });
    expect(users[2]).toMatchObject({ role: 'ADMIN', tokenVersion: 3 });
  });

  it('bumps tokenVersion with a password reset and does not return it', async () => {
    const res = await putUser(makePut({ id: 'user-1', password: 'abcdefgh' }));

    expect(res.status).toBe(200);
    expect(writtenData().tokenVersion).toEqual({ increment: 1 });
    expect(users[2].tokenVersion).toBe(3);
    expect(await res.json()).not.toHaveProperty('tokenVersion');
    expect(mockedSetSession).not.toHaveBeenCalled();
  });

  it('keeps an admin who resets their own password signed in under the new tokenVersion', async () => {
    users[0].tokenVersion = 6;

    const res = await putUser(makePut({ id: 'admin-1', password: 'abcdefgh' }));

    expect(res.status).toBe(200);
    expect(mockedSetSession).toHaveBeenCalledWith({ ...ADMIN, tokenVersion: 7 });
  });
});

describe('GET /api/users (H26)', () => {
  it('lists whether each user is disabled', async () => {
    users[2].disabledAt = new Date('2026-09-01T00:00:00Z');

    const res = await getUsers();

    expect(res.status).toBe(200);
    const list = await res.json();
    expect(list.find((u: any) => u.id === 'user-1').disabledAt).toBe('2026-09-01T00:00:00.000Z');
    expect(list.find((u: any) => u.id === 'admin-2').disabledAt).toBeNull();
  });
});
