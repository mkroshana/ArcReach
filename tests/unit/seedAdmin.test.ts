import { describe, it, expect, vi, beforeEach } from 'vitest';
import { verifyPassword } from '../../lib/auth';
import { PUBLISHED_PASSWORDS, seedAdmin, seedAdminPasswordError } from '../../lib/seedAdmin';
import { matchesWhere } from './helpers/prismaWhere';

type Row = { id: string; email: string; name: string; role: 'ADMIN' | 'USER'; passwordHash: string; disabledAt: Date | null; createdAt: Date };

/** The User table the fake client reads and writes, reset before each test. */
let users: Row[];

function pick(row: Row, select?: Record<string, boolean>) {
  return select ? Object.fromEntries(Object.keys(select).map((k) => [k, (row as any)[k]])) : { ...row };
}

/** A client with every write the seed could make, so a test sees any update it should not do. */
const fake = {
  user: {
    findFirst: vi.fn(async ({ where, select, orderBy }: any) => {
      const rows = users.filter((u) => matchesWhere(u, where));
      if (orderBy?.createdAt === 'asc') rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      return rows[0] ? pick(rows[0], select) : null;
    }),
    findUnique: vi.fn(async ({ where, select }: any) => {
      const row = users.find((u) => u.email === where.email);
      return row ? pick(row, select) : null;
    }),
    create: vi.fn(async ({ data }: any) => {
      const row: Row = { id: `user-${users.length + 1}`, disabledAt: null, createdAt: new Date(), ...data };
      users.push(row);
      return row;
    }),
    update: vi.fn(),
    updateMany: vi.fn(),
    upsert: vi.fn(),
  },
};
const client = fake as any;

const INPUT = { email: 'owner@example.com', name: 'Owner' };

function expectNoWrites() {
  expect(fake.user.create).not.toHaveBeenCalled();
  expect(fake.user.update).not.toHaveBeenCalled();
  expect(fake.user.updateMany).not.toHaveBeenCalled();
  expect(fake.user.upsert).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  users = [];
});

describe('seedAdmin (H40)', () => {
  it('changes nothing and asks for no password once an admin exists, even with the same email', async () => {
    users.push({
      id: 'admin-1', email: INPUT.email, name: 'Renamed', role: 'ADMIN',
      passwordHash: 'their-own-hash', disabledAt: null, createdAt: new Date('2026-01-01'),
    });
    const readPassword = vi.fn(async () => 'a-brand-new-password');

    const result = await seedAdmin(client, INPUT, readPassword);

    expect(result).toEqual({ outcome: 'admin-exists', email: INPUT.email });
    expect(readPassword).not.toHaveBeenCalled();
    expectNoWrites();
    expect(users[0]).toMatchObject({ passwordHash: 'their-own-hash', name: 'Renamed', disabledAt: null });
  });

  it('leaves a disabled admin disabled and creates no second admin', async () => {
    const disabledAt = new Date('2026-05-01');
    users.push({
      id: 'admin-1', email: 'first@example.com', name: 'First', role: 'ADMIN',
      passwordHash: 'hash', disabledAt, createdAt: new Date('2026-01-01'),
    });
    const readPassword = vi.fn(async () => 'a-brand-new-password');

    const result = await seedAdmin(client, INPUT, readPassword);

    expect(result).toEqual({ outcome: 'admin-exists', email: 'first@example.com' });
    expect(readPassword).not.toHaveBeenCalled();
    expectNoWrites();
    expect(users).toHaveLength(1);
    expect(users[0].disabledAt).toBe(disabledAt);
  });

  it('refuses an email that belongs to a user instead of promoting them or setting their password', async () => {
    users.push({
      id: 'user-1', email: INPUT.email, name: 'Marketer', role: 'USER',
      passwordHash: 'their-own-hash', disabledAt: null, createdAt: new Date('2026-01-01'),
    });
    const readPassword = vi.fn(async () => 'a-brand-new-password');

    const result = await seedAdmin(client, INPUT, readPassword);

    expect(result).toEqual({ outcome: 'email-taken', email: INPUT.email });
    expect(readPassword).not.toHaveBeenCalled();
    expectNoWrites();
    expect(users[0]).toMatchObject({ role: 'USER', passwordHash: 'their-own-hash' });
  });

  it('creates the first admin with a hash of the password it was given', async () => {
    const result = await seedAdmin(client, INPUT, async () => 'a-brand-new-password');

    expect(result).toEqual({ outcome: 'created', email: INPUT.email });
    expect(fake.user.create).toHaveBeenCalledTimes(1);
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ email: INPUT.email, name: 'Owner', role: 'ADMIN' });
    expect(users[0].passwordHash).not.toContain('a-brand-new-password');
    expect(await verifyPassword('a-brand-new-password', users[0].passwordHash)).toBe(true);
  });

  it('refuses the published default password and creates nothing', async () => {
    const result = await seedAdmin(client, INPUT, async () => 'securepassword123');

    expect(result).toEqual({ outcome: 'invalid-password', error: expect.stringMatching(/published default/) });
    expectNoWrites();
  });

  it('refuses an empty or short password and creates nothing', async () => {
    for (const password of ['', 'short']) {
      const result = await seedAdmin(client, INPUT, async () => password);
      expect(result).toEqual({ outcome: 'invalid-password', error: expect.stringMatching(/at least 8 characters/) });
    }
    expectNoWrites();
  });
});

describe('seedAdminPasswordError', () => {
  it('refuses every published password and accepts another that meets the policy', () => {
    for (const password of PUBLISHED_PASSWORDS) expect(seedAdminPasswordError(password)).not.toBeNull();
    expect(seedAdminPasswordError('a-brand-new-password')).toBeNull();
  });
});
