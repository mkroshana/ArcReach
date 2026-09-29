import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import * as jose from 'jose';

/** The request's cookie store, as next/headers hands it to lib/session and the auth routes. */
const jar = vi.hoisted(() => {
  const values = new Map<string, string>();
  return {
    values,
    store: {
      get: (name: string) => (values.has(name) ? { name, value: values.get(name)! } : undefined),
      set: vi.fn((name: string, value: string) => { values.set(name, value); }),
      delete: vi.fn((name: string) => { values.delete(name); }),
    },
  };
});

vi.mock('next/headers', () => ({
  cookies: async () => jar.store,
}));

vi.mock('../../lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn(), update: vi.fn() },
  },
}));

import { prisma } from '../../lib/db';
import { hashPassword } from '../../lib/auth';
import { sessionSecretKey } from '../../lib/sessionSecret';
import { getSession, signSession } from '../../lib/session';
import { UnauthorizedError } from '../../lib/sessionError';
import { POST as login } from '../../app/api/auth/login/route';
import { POST as logout, GET as logoutViaGet } from '../../app/api/auth/logout/route';
import { PUT as putSettings } from '../../app/api/settings/route';

const mockedPrisma = prisma as any;

type UserRow = {
  id: string; name: string | null; email: string; role: 'ADMIN' | 'USER';
  passwordHash: string; tokenVersion: number; disabledAt: Date | null;
};

const PASSWORD = 'correct-password-1';
let passwordHash: string;

/** The User table getSession and the auth routes read, reset before each test. */
let users: UserRow[];

const CLAIMS = { id: 'admin-1', name: 'Old Name', email: 'admin@example.com', role: 'ADMIN' as const };

function row(id: string): UserRow {
  const user = users.find((u) => u.id === id);
  if (!user) throw new Error(`no user ${id}`);
  return user;
}

function settingsRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function loginRequest(email: string, password: string): NextRequest {
  return new NextRequest('http://localhost/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
}

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD);
});

beforeEach(() => {
  vi.clearAllMocks();
  jar.values.clear();
  users = [
    { id: 'admin-1', name: 'Ada Admin', email: 'admin@example.com', role: 'ADMIN', passwordHash, tokenVersion: 3, disabledAt: null },
  ];
  mockedPrisma.user.findUnique.mockImplementation(async ({ where, select }: any) => {
    const user = users.find((u) => (where.id !== undefined ? u.id === where.id : u.email === where.email));
    if (!user) return null;
    return select ? Object.fromEntries(Object.keys(select).map((k) => [k, (user as any)[k]])) : { ...user };
  });
  mockedPrisma.user.update.mockImplementation(async ({ where, data }: any) => {
    const user = row(where.id);
    for (const [key, value] of Object.entries(data)) {
      (user as any)[key] = value && typeof value === 'object' && 'increment' in value
        ? (user as any)[key] + (value as any).increment
        : value;
    }
    return { ...user };
  });
});

describe('getSession checks every session against the database (H26)', () => {
  it('refuses a request with no session cookie without reading the database', async () => {
    await expect(getSession()).rejects.toBeInstanceOf(UnauthorizedError);
    expect(mockedPrisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('accepts a session signed under the current tokenVersion and takes name, email and role from the database', async () => {
    row('admin-1').role = 'USER';
    jar.values.set('user_session', await signSession({ ...CLAIMS, tokenVersion: 3 }));

    const session = await getSession();

    // The token still says ADMIN and "Old Name"; a demoted admin gets USER.
    expect(session).toEqual({ id: 'admin-1', name: 'Ada Admin', email: 'admin@example.com', role: 'USER' });
    expect(mockedPrisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'admin-1' },
      select: { id: true, name: true, email: true, role: true, tokenVersion: true, disabledAt: true },
    });
  });

  it('refuses a session signed under an older tokenVersion and clears its cookie', async () => {
    jar.values.set('user_session', await signSession({ ...CLAIMS, tokenVersion: 2 }));

    await expect(getSession()).rejects.toBeInstanceOf(UnauthorizedError);
    expect(jar.store.delete).toHaveBeenCalledWith('user_session');
    expect(jar.values.has('user_session')).toBe(false);
  });

  it('refuses a disabled user even under the current tokenVersion', async () => {
    row('admin-1').disabledAt = new Date();
    jar.values.set('user_session', await signSession({ ...CLAIMS, tokenVersion: 3 }));

    await expect(getSession()).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('refuses a deleted user', async () => {
    jar.values.set('user_session', await signSession({ ...CLAIMS, tokenVersion: 3 }));
    users = [];

    await expect(getSession()).rejects.toBeInstanceOf(UnauthorizedError);
    expect(jar.values.has('user_session')).toBe(false);
  });

  it('treats a session signed before tokenVersion existed as version 0', async () => {
    const legacy = await new jose.SignJWT({ ...CLAIMS })
      .setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('7d').sign(sessionSecretKey);
    jar.values.set('user_session', legacy);

    row('admin-1').tokenVersion = 0;
    await expect(getSession()).resolves.toMatchObject({ id: 'admin-1' });

    row('admin-1').tokenVersion = 1;
    await expect(getSession()).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('refuses a cookie signed with another secret without reading the database', async () => {
    const forged = await new jose.SignJWT({ ...CLAIMS, tokenVersion: 3 })
      .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('7d')
      .sign(new TextEncoder().encode('not-the-session-secret-at-all-32-chars'));
    jar.values.set('user_session', forged);

    await expect(getSession()).rejects.toBeInstanceOf(UnauthorizedError);
    expect(mockedPrisma.user.findUnique).not.toHaveBeenCalled();
    expect(jar.values.has('user_session')).toBe(false);
  });

  it('lets a database failure through as an error, not a refusal, and keeps the cookie', async () => {
    jar.values.set('user_session', await signSession({ ...CLAIMS, tokenVersion: 3 }));
    mockedPrisma.user.findUnique.mockRejectedValueOnce(new Error('connection refused'));

    const error = await getSession().catch((e) => e);
    expect(error).not.toBeInstanceOf(UnauthorizedError);
    expect(error.message).toBe('connection refused');
    expect(jar.values.has('user_session')).toBe(true);
  });
});

describe('POST /api/auth/login (H26)', () => {
  it('signs the user\'s tokenVersion into the cookie, so a later bump ends the session', async () => {
    const res = await login(loginRequest('admin@example.com', PASSWORD));
    expect(res.status).toBe(200);

    const { payload } = await jose.jwtVerify(jar.values.get('user_session')!, sessionSecretKey);
    expect(payload.tokenVersion).toBe(3);
    await expect(getSession()).resolves.toMatchObject({ id: 'admin-1', role: 'ADMIN' });

    row('admin-1').tokenVersion = 4;
    await expect(getSession()).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('refuses a disabled user with the right password and sets no cookie', async () => {
    row('admin-1').disabledAt = new Date();

    const res = await login(loginRequest('admin@example.com', PASSWORD));

    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('This account has been disabled. Ask an admin to enable it.');
    expect(jar.store.set).not.toHaveBeenCalled();
  });

  it('still answers a wrong password with 401 before looking at the disabled flag', async () => {
    row('admin-1').disabledAt = new Date();

    const res = await login(loginRequest('admin@example.com', 'wrong-password'));

    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('Invalid email or password.');
  });
});

describe('POST /api/auth/logout (H26)', () => {
  it('bumps tokenVersion, so a copy of the cookie stops working, and clears the cookie', async () => {
    const token = await signSession({ ...CLAIMS, tokenVersion: 3 });
    jar.values.set('user_session', token);

    const res = await logout();

    expect(res.status).toBe(200);
    expect(mockedPrisma.user.update).toHaveBeenCalledWith({ where: { id: 'admin-1' }, data: { tokenVersion: { increment: 1 } } });
    expect(row('admin-1').tokenVersion).toBe(4);
    expect(jar.values.has('user_session')).toBe(false);

    // Someone replaying the old cookie is refused.
    jar.values.set('user_session', token);
    await expect(getSession()).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('clears the cookie without writing when there is no live session', async () => {
    jar.values.set('user_session', await signSession({ ...CLAIMS, tokenVersion: 1 }));

    const res = await logout();

    expect(res.status).toBe(200);
    expect(mockedPrisma.user.update).not.toHaveBeenCalled();
    expect(jar.values.has('user_session')).toBe(false);
  });
});

describe('GET /api/auth/logout (H26)', () => {
  it('clears only this browser cookie: a cross-site link cannot end the user\'s other sessions', async () => {
    const token = await signSession({ ...CLAIMS, tokenVersion: 3 });
    jar.values.set('user_session', token);

    const res = await logoutViaGet();

    expect(res.status).toBe(200);
    expect(mockedPrisma.user.update).not.toHaveBeenCalled();
    expect(row('admin-1').tokenVersion).toBe(3);
    expect(jar.values.has('user_session')).toBe(false);

    // Another browser holding the same session stays signed in.
    jar.values.set('user_session', token);
    await expect(getSession()).resolves.toMatchObject({ id: 'admin-1' });
  });
});

describe('PUT /api/settings (H26)', () => {
  it('ends every other session on a password change and keeps this one under the new tokenVersion', async () => {
    const oldToken = await signSession({ ...CLAIMS, tokenVersion: 3 });
    jar.values.set('user_session', oldToken);

    const res = await putSettings(settingsRequest({ currentPassword: PASSWORD, newPassword: 'new-password-2' }));

    expect(res.status).toBe(200);
    expect(row('admin-1').tokenVersion).toBe(4);
    const { payload } = await jose.jwtVerify(jar.values.get('user_session')!, sessionSecretKey);
    expect(payload.tokenVersion).toBe(4);
    await expect(getSession()).resolves.toMatchObject({ id: 'admin-1' });

    // Another browser still holding the old cookie is signed out.
    jar.values.set('user_session', oldToken);
    await expect(getSession()).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('does not re-sign the cookie for a profile update: the next request reads the new name from the database', async () => {
    jar.values.set('user_session', await signSession({ ...CLAIMS, tokenVersion: 3 }));

    const res = await putSettings(settingsRequest({ name: 'Ada Lovelace' }));

    expect(res.status).toBe(200);
    expect(jar.store.set).not.toHaveBeenCalled();
    expect(row('admin-1').tokenVersion).toBe(3);
    await expect(getSession()).resolves.toMatchObject({ name: 'Ada Lovelace' });
  });
});
