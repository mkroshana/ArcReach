import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/db', () => ({
  prisma: {
    template: {
      findMany: vi.fn(),
      create: vi.fn(),
      createMany: vi.fn(),
    },
  },
}));

vi.mock('../../lib/session', () => ({
  getSession: vi.fn(),
}));

import { prisma } from '../../lib/db';
import { getSession } from '../../lib/session';
import { GET } from '../../app/api/templates/route';

const mockedPrisma = prisma as any;
const mockedSession = vi.mocked(getSession);

const USER = { id: 'user-1', name: 'User', email: 'user@example.com', role: 'USER' as const };

/** The Template table the mocked Prisma calls run against. */
let rows: Record<string, any>[];

beforeEach(() => {
  vi.clearAllMocks();
  rows = [];
  mockedSession.mockResolvedValue(USER);
  mockedPrisma.template.findMany.mockImplementation(async () => rows.map((r) => ({ ...r })));
  mockedPrisma.template.create.mockImplementation(async ({ data }: any) => { rows.push({ id: `t-${rows.length + 1}`, ...data }); return data; });
  mockedPrisma.template.createMany.mockImplementation(async ({ data }: any) => { rows.push(...data); return { count: data.length }; });
});

describe('GET /api/templates never seeds placeholder templates (L23)', () => {
  it('returns an empty library as empty and writes nothing', async () => {
    const res = await GET();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
    expect(rows).toEqual([]);
    expect(mockedPrisma.template.create).not.toHaveBeenCalled();
    expect(mockedPrisma.template.createMany).not.toHaveBeenCalled();
  });

  it('stays empty on every later load after the library is cleared', async () => {
    for (let i = 0; i < 3; i++) {
      expect(await (await GET()).json()).toEqual([]);
    }
    expect(rows).toEqual([]);
  });

  it('returns the saved templates newest first, unchanged', async () => {
    rows = [
      { id: 't-2', name: 'Follow Up', subject: 'Checking in', body: 'Hi {{firstName}}', category: 'Follow Up' },
      { id: 't-1', name: 'Intro', subject: 'Hello', body: 'Hi {{firstName}}', category: 'Cold Outreach' },
    ];

    const res = await GET();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(rows);
    expect(mockedPrisma.template.findMany).toHaveBeenCalledWith({ orderBy: { createdAt: 'desc' } });
    expect(mockedPrisma.template.createMany).not.toHaveBeenCalled();
  });
});
