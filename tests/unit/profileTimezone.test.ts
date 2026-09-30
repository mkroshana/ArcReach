import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('../../lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn(), update: vi.fn() },
  },
}));

vi.mock('../../lib/session', () => ({
  getSession: vi.fn(),
  setSession: vi.fn(),
}));

import { prisma } from '../../lib/db';
import { getSession } from '../../lib/session';
import { GET as getSettings, PUT as putSettings } from '../../app/api/settings/route';

const mockedPrisma = prisma as any;
const mockedSession = vi.mocked(getSession);

const USER = { id: 'user-1', name: 'Ada Lovelace', email: 'ada@example.com', role: 'USER' as const };

/** The caller's User row, with a timezone saved before the profile stopped offering it. */
let user: Record<string, any>;

function settingsRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  user = {
    ...USER, organization: 'Analytical Engines', timezone: 'Asia/Colombo',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  };
  mockedSession.mockResolvedValue(USER);
  mockedPrisma.user.findUnique.mockImplementation(async ({ select }: any) =>
    select ? Object.fromEntries(Object.keys(select).map((k) => [k, user[k]])) : { ...user },
  );
  mockedPrisma.user.update.mockImplementation(async ({ data }: any) => {
    Object.assign(user, data);
    return { ...user };
  });
});

describe('the profile has no timezone, since nothing reads User.timezone (L25)', () => {
  it('leaves the timezone out of GET /api/settings', async () => {
    const res = await getSettings();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user).toMatchObject({ name: 'Ada Lovelace', organization: 'Analytical Engines' });
    expect(body.user).not.toHaveProperty('timezone');
  });

  it('saves the name and organization but not a timezone sent with them', async () => {
    const res = await putSettings(settingsRequest({ name: 'Ada King', organization: 'Engines Ltd', timezone: 'America/New_York' }));

    expect(res.status).toBe(200);
    expect(mockedPrisma.user.update).toHaveBeenCalledTimes(1);
    expect(mockedPrisma.user.update.mock.calls[0][0].data).toEqual({ name: 'Ada King', organization: 'Engines Ltd' });
    expect(user).toMatchObject({ name: 'Ada King', organization: 'Engines Ltd', timezone: 'Asia/Colombo' });
  });

  it('writes nothing for a request that only sends a timezone', async () => {
    const res = await putSettings(settingsRequest({ timezone: 'America/New_York' }));

    expect(res.status).toBe(200);
    expect(mockedPrisma.user.update).not.toHaveBeenCalled();
    expect(user.timezone).toBe('Asia/Colombo');
  });
});
