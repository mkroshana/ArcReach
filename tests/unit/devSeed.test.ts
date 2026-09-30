import { describe, it, expect, vi, afterEach } from 'vitest';
import { devSeedRefusal, isLocalOrTestDatabaseUrl } from '../../lib/devSeed';

/** The fake client lib/db gets, so the lazy dev seeding runs for real against it. */
const fake = vi.hoisted(() => ({
  user: { findUnique: vi.fn(), create: vi.fn(), findMany: vi.fn() },
}));

vi.mock('@prisma/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@prisma/client')>()),
  PrismaClient: class {
    constructor() {
      return fake;
    }
  },
}));

const REMOTE = 'postgresql://arcadmin:secret@arcreach-db.postgres.database.azure.com:5432/arcreach?sslmode=require';
const LOCAL = 'postgresql://username:password@localhost:5432/arcreach?schema=public';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.clearAllMocks();
});

describe('isLocalOrTestDatabaseUrl (H40)', () => {
  it('accepts a database on this machine', () => {
    for (const url of [
      LOCAL,
      'postgresql://postgres:postgres@127.0.0.1:5432/arcreach',
      'postgres://postgres@[::1]:5432/arcreach',
      'postgresql://postgres@db.localhost/arcreach',
      'postgresql://postgres@LOCALHOST/arcreach',
      'postgresql://postgres@server/arcreach?host=/var/run/postgresql',
      'postgresql://postgres@%2Fvar%2Frun%2Fpostgresql/arcreach',
    ]) {
      expect(isLocalOrTestDatabaseUrl(url), url).toBe(true);
    }
  });

  it('accepts a test database on any host, as CI names it', () => {
    expect(isLocalOrTestDatabaseUrl('postgresql://postgres:postgres@ci-db:5432/arcreach_test')).toBe(true);
    expect(isLocalOrTestDatabaseUrl('postgresql://postgres@ci-db/test')).toBe(true);
    expect(isLocalOrTestDatabaseUrl('postgresql://postgres@ci-db/test-arcreach?schema=public')).toBe(true);
  });

  it('refuses a shared database, a name that only contains "test", and a missing or unreadable URL', () => {
    for (const url of [
      REMOTE,
      'postgresql://user:pw@ep-cool-name.eu-central-1.aws.neon.tech/arcreach?sslmode=require',
      // 'localhost' in the password or user is not the host
      'postgresql://localhost:localhost@arcreach-db.example.com/arcreach',
      'postgresql://postgres@db.example.com/latest',
      'postgresql://postgres@db.example.com/contests',
      'postgresql://postgres@localhost.example.com/arcreach',
      // ?host= overrides the URL's host
      'postgresql://postgres@localhost/arcreach?host=db.example.com',
      'postgresql:///arcreach',
      'not a url',
      '',
      undefined,
    ]) {
      expect(isLocalOrTestDatabaseUrl(url), String(url)).toBe(false);
    }
  });
});

describe('devSeedRefusal (H40)', () => {
  it('allows a local database outside production', () => {
    expect(devSeedRefusal({ NODE_ENV: 'development', DATABASE_URL: LOCAL })).toBeNull();
    expect(devSeedRefusal({ DATABASE_URL: LOCAL })).toBeNull();
  });

  it('refuses production even on a local database', () => {
    expect(devSeedRefusal({ NODE_ENV: 'production', DATABASE_URL: LOCAL })).toMatch(/NODE_ENV is production/);
  });

  it('refuses a shared database and names what it accepts', () => {
    expect(devSeedRefusal({ NODE_ENV: 'development', DATABASE_URL: REMOTE })).toMatch(/local database/);
  });
});

describe('lib/db lazy dev seeding (H40)', () => {
  /** lib/db loaded under `env`, then one db helper called so ensureInit runs. */
  async function runHelperWith(env: Record<string, string>) {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    vi.resetModules();
    // lib/db keeps its client on globalThis outside production; start from this file's fake.
    (globalThis as { prisma?: unknown }).prisma = undefined;
    fake.user.findUnique.mockResolvedValue(null);
    fake.user.create.mockResolvedValue({});
    fake.user.findMany.mockResolvedValue([]);
    const { db } = await import('../../lib/db');
    await db.getUsers();
  }

  it('adds no users when `npm run dev` points at a shared database', async () => {
    await runHelperWith({ NODE_ENV: 'development', DATABASE_URL: REMOTE });

    expect(fake.user.findUnique).not.toHaveBeenCalled();
    expect(fake.user.create).not.toHaveBeenCalled();
    expect(fake.user.findMany).toHaveBeenCalledTimes(1);
  });

  it('still adds the missing dev users to a local database', async () => {
    await runHelperWith({ NODE_ENV: 'development', DATABASE_URL: LOCAL });

    expect(fake.user.create).toHaveBeenCalledTimes(2);
    expect(fake.user.create.mock.calls.map(([args]) => args.data.id)).toEqual(['admin-id-999', 'user-id-111']);
  });
});
