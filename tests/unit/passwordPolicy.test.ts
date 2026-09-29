import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('../../lib/db', () => ({
  db: {
    createUser: vi.fn(),
    updateUserRole: vi.fn(),
    updateUserPassword: vi.fn(),
  },
  prisma: {
    user: { findUnique: vi.fn(), update: vi.fn() },
  },
}));

vi.mock('../../lib/session', () => ({
  getSession: vi.fn(),
  setSession: vi.fn(),
}));

import { db, prisma } from '../../lib/db';
import { getSession } from '../../lib/session';
import { hashPassword, verifyPassword } from '../../lib/auth';
import { MIN_PASSWORD_LENGTH, passwordPolicyError } from '../../lib/passwordPolicy';
import { PUT as putSettings } from '../../app/api/settings/route';
import { POST as postUser, PUT as putUser } from '../../app/api/users/route';

const mockedDb = db as any;
const mockedPrisma = prisma as any;
const mockedSession = vi.mocked(getSession);

const USER = { id: 'user-1', name: 'User', email: 'user@example.com', role: 'USER' as const };
const ADMIN = { id: 'admin-1', name: 'Admin', email: 'admin@example.com', role: 'ADMIN' as const };
const CURRENT_PASSWORD = 'current-password-1';
const POLICY_MESSAGE = `A password of at least ${MIN_PASSWORD_LENGTH} characters is required.`;

/** The signed-in user's stored hash, computed once because PBKDF2 at full cost is slow. */
let storedHash: string;

function makeReq(path: string, method: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  storedHash = await hashPassword(CURRENT_PASSWORD);
});

beforeEach(() => {
  vi.clearAllMocks();
  mockedPrisma.user.findUnique.mockImplementation(async () => ({ id: USER.id, passwordHash: storedHash }));
  mockedPrisma.user.update.mockImplementation(async ({ where }: any) => ({ id: where.id }));
  mockedDb.createUser.mockImplementation(async (data: any) => ({ id: 'new-user', email: data.email }));
  mockedDb.updateUserPassword.mockImplementation(async (id: string) => ({ id }));
});

describe('passwordPolicyError (L14)', () => {
  it('rejects passwords shorter than the minimum, empty values and non-strings', () => {
    expect(passwordPolicyError('a')).toBe(POLICY_MESSAGE);
    expect(passwordPolicyError('x'.repeat(MIN_PASSWORD_LENGTH - 1))).toBe(POLICY_MESSAGE);
    expect(passwordPolicyError('')).toBe(POLICY_MESSAGE);
    expect(passwordPolicyError(undefined)).toBe(POLICY_MESSAGE);
    expect(passwordPolicyError(null)).toBe(POLICY_MESSAGE);
    expect(passwordPolicyError(12345678)).toBe(POLICY_MESSAGE);
    expect(passwordPolicyError(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'])).toBe(POLICY_MESSAGE);
  });

  it('accepts a password at or above the minimum length', () => {
    expect(MIN_PASSWORD_LENGTH).toBe(8);
    expect(passwordPolicyError('x'.repeat(MIN_PASSWORD_LENGTH))).toBeNull();
    expect(passwordPolicyError('correct horse battery staple')).toBeNull();
  });
});

describe('PUT /api/settings password change (L14)', () => {
  beforeEach(() => {
    mockedSession.mockResolvedValue(USER);
  });

  it.each([
    ['a single character', 'a'],
    ['seven characters', 'abcdefg'],
    ['an empty string', ''],
    ['null', null],
  ])('refuses %s as the new password and writes nothing', async (_label, newPassword) => {
    const res = await putSettings(makeReq('/api/settings', 'PUT', { currentPassword: CURRENT_PASSWORD, newPassword }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(POLICY_MESSAGE);
    expect(mockedPrisma.user.update).not.toHaveBeenCalled();
  });

  it('stores a hash of a new password that meets the minimum', async () => {
    const res = await putSettings(makeReq('/api/settings', 'PUT', { currentPassword: CURRENT_PASSWORD, newPassword: 'abcdefgh' }));
    expect(res.status).toBe(200);
    expect(mockedPrisma.user.update).toHaveBeenCalledTimes(1);
    const { where, data } = mockedPrisma.user.update.mock.calls[0][0];
    expect(where).toEqual({ id: USER.id });
    expect(await verifyPassword('abcdefgh', data.passwordHash)).toBe(true);
  });

  it('still requires the current password to match', async () => {
    const res = await putSettings(makeReq('/api/settings', 'PUT', { currentPassword: 'wrong-password', newPassword: 'abcdefgh' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Current password does not match.');
    expect(mockedPrisma.user.update).not.toHaveBeenCalled();
  });
});

describe('/api/users password rules (L14)', () => {
  beforeEach(() => {
    mockedSession.mockResolvedValue(ADMIN);
  });

  it('refuses to create a user with a short password', async () => {
    const res = await postUser(makeReq('/api/users', 'POST', { email: 'new@example.com', role: 'USER', password: 'short' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(POLICY_MESSAGE);
    expect(mockedDb.createUser).not.toHaveBeenCalled();
  });

  it('creates a user whose password meets the minimum', async () => {
    const res = await postUser(makeReq('/api/users', 'POST', { email: 'new@example.com', role: 'USER', password: 'abcdefgh' }));
    expect(res.status).toBe(200);
    expect(mockedDb.createUser).toHaveBeenCalledWith(expect.objectContaining({ email: 'new@example.com', password: 'abcdefgh' }));
  });

  it.each([
    ['a short password', 'short'],
    ['an empty password', ''],
  ])('refuses to reset to %s', async (_label, password) => {
    const res = await putUser(makeReq('/api/users', 'PUT', { id: 'user-1', password }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(POLICY_MESSAGE);
    expect(mockedDb.updateUserPassword).not.toHaveBeenCalled();
  });

  it('resets to a password that meets the minimum', async () => {
    const res = await putUser(makeReq('/api/users', 'PUT', { id: 'user-1', password: 'abcdefgh' }));
    expect(res.status).toBe(200);
    expect(mockedDb.updateUserPassword).toHaveBeenCalledWith('user-1', 'abcdefgh');
  });
});
