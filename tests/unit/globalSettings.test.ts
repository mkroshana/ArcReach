import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';

vi.mock('../../lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    globalSettings: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      upsert: vi.fn(),
    },
    emailDispatch: { count: vi.fn() },
  },
}));

vi.mock('../../lib/session', () => ({
  getSession: vi.fn(),
  setSession: vi.fn(),
}));

import { prisma } from '../../lib/db';
import { getSession } from '../../lib/session';
import { GLOBAL_SETTINGS_ID, getGlobalSettings, ensureGlobalSettings, saveGlobalSettings } from '../../lib/settings';
import { GET as getSettings, PUT as putSettings } from '../../app/api/settings/route';
import { checkGlobalRateLimits } from '../../lib/rateLimits';
import { MAX_GLOBAL_RATE_LIMIT, globalRateLimitError, rateLimitInputFrom, rateLimitInputValue } from '../../lib/rateLimitPolicy';

const mockedPrisma = prisma as any;
const mockedSession = vi.mocked(getSession);

const ADMIN = { id: 'admin-1', name: 'Admin', email: 'admin@example.com', role: 'ADMIN' as const };

type Row = Record<string, any> & { id: string; updatedAt: Date };

/** The GlobalSettings table the mocked Prisma calls run against. `id` is the
 * primary key, so a second row under the same id is a unique violation. */
let rows: Row[];
let clock: number;

const tick = () => new Date(Date.UTC(2026, 8, 1) + ++clock * 1000);
const knownError = (code: string) =>
  new Prisma.PrismaClientKnownRequestError(`Mocked ${code}`, { code, clientVersion: 'test' });

function insert(data: Record<string, any>): Row {
  const id = data.id ?? 'uuid-default';
  if (rows.some((r) => r.id === id)) throw knownError('P2002');
  const row: Row = { activeProvider: 'MOCK', rateLimitMinute: 60, rateLimitHour: 1000, ...data, id, updatedAt: tick() };
  rows.push(row);
  return { ...row };
}

function apply(id: string, data: Record<string, any>): Row {
  const row = rows.find((r) => r.id === id);
  if (!row) throw knownError('P2025');
  if (data.id !== undefined && data.id !== id && rows.some((r) => r.id === data.id)) throw knownError('P2002');
  Object.assign(row, data, { updatedAt: tick() });
  return { ...row };
}

function makeReq(method: string, body?: unknown): NextRequest {
  return new NextRequest('http://localhost/api/settings', {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  rows = [];
  clock = 0;
  mockedSession.mockResolvedValue(ADMIN);
  mockedPrisma.user.findUnique.mockResolvedValue(null);
  const gs = mockedPrisma.globalSettings;
  gs.findUnique.mockImplementation(async ({ where }: any) => {
    const row = rows.find((r) => r.id === where.id);
    return row ? { ...row } : null;
  });
  gs.findFirst.mockImplementation(async ({ orderBy }: any = {}) => {
    const sorted = [...rows];
    if (orderBy) {
      expect(orderBy).toEqual([{ updatedAt: 'desc' }, { id: 'asc' }]);
      sorted.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || a.id.localeCompare(b.id));
    }
    return sorted[0] ? { ...sorted[0] } : null;
  });
  gs.create.mockImplementation(async ({ data }: any) => insert(data));
  gs.update.mockImplementation(async ({ where, data }: any) => apply(where.id, data));
  gs.upsert.mockImplementation(async ({ where, update, create }: any) =>
    rows.some((r) => r.id === where.id) ? apply(where.id, update) : insert(create),
  );
});

describe('getGlobalSettings (M9)', () => {
  it('reads the row under the fixed id and leaves any other rows alone', async () => {
    insert({ id: 'legacy-uuid', activeProvider: 'MOCK' });
    insert({ id: GLOBAL_SETTINGS_ID, activeProvider: 'AZURE' });

    const settings = await getGlobalSettings();

    expect(settings).toMatchObject({ id: GLOBAL_SETTINGS_ID, activeProvider: 'AZURE' });
    expect(mockedPrisma.globalSettings.update).not.toHaveBeenCalled();
    expect(rows.map((r) => r.id).sort()).toEqual(['global', 'legacy-uuid']);
  });

  it('returns null when the table is empty', async () => {
    expect(await getGlobalSettings()).toBeNull();
  });

  it('adopts the most recently updated legacy row by re-keying it to the fixed id', async () => {
    insert({ id: 'uuid-b', activeProvider: 'MOCK' });
    insert({ id: 'uuid-a', activeProvider: 'AZURE', azureConnString: 'enc:conn' });

    const settings = await getGlobalSettings();

    expect(settings).toMatchObject({ id: GLOBAL_SETTINGS_ID, activeProvider: 'AZURE', azureConnString: 'enc:conn' });
    expect(rows.map((r) => r.id).sort()).toEqual(['global', 'uuid-b']);

    // Later reads hit the adopted row directly and never re-key again.
    mockedPrisma.globalSettings.update.mockClear();
    expect(await getGlobalSettings()).toMatchObject({ id: GLOBAL_SETTINGS_ID, activeProvider: 'AZURE' });
    expect(mockedPrisma.globalSettings.update).not.toHaveBeenCalled();
  });

  it('lets concurrent readers both land on the one adopted row', async () => {
    insert({ id: 'uuid-a', activeProvider: 'AZURE' });

    const [first, second] = await Promise.all([getGlobalSettings(), getGlobalSettings()]);

    expect(first).toMatchObject({ id: GLOBAL_SETTINGS_ID, activeProvider: 'AZURE' });
    expect(second).toMatchObject({ id: GLOBAL_SETTINGS_ID, activeProvider: 'AZURE' });
    expect(rows.map((r) => r.id)).toEqual(['global']);
    // Both tried the re-key; the loser's update found no uuid row and re-read instead.
    expect(mockedPrisma.globalSettings.update).toHaveBeenCalledTimes(2);
  });

  it('rethrows when the re-key fails and no adopted row exists', async () => {
    insert({ id: 'uuid-a' });
    mockedPrisma.globalSettings.update.mockRejectedValueOnce(new Error('connection lost'));

    await expect(getGlobalSettings()).rejects.toThrow('connection lost');
  });
});

describe('ensureGlobalSettings (M9)', () => {
  it('creates the row under the fixed id from the defaults on first use', async () => {
    const settings = await ensureGlobalSettings({ activeProvider: 'MOCK', rateLimitMinute: 60 });

    expect(settings).toMatchObject({ id: GLOBAL_SETTINGS_ID, activeProvider: 'MOCK', rateLimitMinute: 60 });
    expect(rows).toHaveLength(1);
  });

  it('returns the existing row without applying the defaults', async () => {
    insert({ id: GLOBAL_SETTINGS_ID, activeProvider: 'AZURE' });

    const settings = await ensureGlobalSettings({ activeProvider: 'MOCK' });

    expect(settings.activeProvider).toBe('AZURE');
    expect(mockedPrisma.globalSettings.create).not.toHaveBeenCalled();
  });

  it('creates exactly one row when two first loads race', async () => {
    const [first, second] = await Promise.all([
      ensureGlobalSettings({ activeProvider: 'MOCK' }),
      ensureGlobalSettings({ activeProvider: 'MOCK' }),
    ]);

    expect(rows).toHaveLength(1);
    expect(first.id).toBe(GLOBAL_SETTINGS_ID);
    expect(second.id).toBe(GLOBAL_SETTINGS_ID);
    // Both tried the insert; the loser's hit the primary key and re-read instead.
    expect(mockedPrisma.globalSettings.create).toHaveBeenCalledTimes(2);
  });
});

describe('saveGlobalSettings (M9)', () => {
  it('creates the row under the fixed id when none exists', async () => {
    const saved = await saveGlobalSettings({ activeProvider: 'AZURE' }, { activeProvider: 'AZURE', rateLimitHour: 500 });

    expect(saved).toMatchObject({ id: GLOBAL_SETTINGS_ID, activeProvider: 'AZURE', rateLimitHour: 500 });
    expect(rows).toHaveLength(1);
  });

  it('merges into a legacy row instead of stranding its values', async () => {
    insert({ id: 'uuid-a', activeProvider: 'AZURE', azureConnString: 'enc:conn', rateLimitMinute: 60 });

    const saved = await saveGlobalSettings({ rateLimitMinute: 5 }, { rateLimitMinute: 5 });

    expect(saved).toMatchObject({ id: GLOBAL_SETTINGS_ID, activeProvider: 'AZURE', azureConnString: 'enc:conn', rateLimitMinute: 5 });
    expect(rows).toHaveLength(1);
  });
});

describe('/api/settings uses the single settings row (M9)', () => {
  it('creates one row when the settings page loads twice against an empty table', async () => {
    const [a, b] = await Promise.all([getSettings(), getSettings()]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(GLOBAL_SETTINGS_ID);
  });

  it('saves the provider onto the row the send engine reads', async () => {
    await Promise.all([getSettings(), getSettings()]);

    const res = await putSettings(makeReq('PUT', { activeProvider: 'AZURE', rateLimitMinute: 30 }));

    expect(res.status).toBe(200);
    expect((await res.json()).settings).toMatchObject({ id: GLOBAL_SETTINGS_ID, activeProvider: 'AZURE', rateLimitMinute: 30 });
    expect(await getGlobalSettings()).toMatchObject({ activeProvider: 'AZURE', rateLimitMinute: 30 });
    expect(rows).toHaveLength(1);
  });

  it('saves onto a legacy uuid-keyed row rather than creating a second one', async () => {
    insert({ id: 'uuid-a', activeProvider: 'MOCK', azureConnString: 'enc:conn' });

    const res = await putSettings(makeReq('PUT', { activeProvider: 'AZURE' }));

    expect(res.status).toBe(200);
    expect(rows).toEqual([expect.objectContaining({ id: GLOBAL_SETTINGS_ID, activeProvider: 'AZURE', azureConnString: 'enc:conn' })]);
  });
});

describe('first GET /api/settings seeds no fake SMTP settings (M17)', () => {
  it('creates the row with sending disabled and every SMTP field unset', async () => {
    const res = await getSettings();

    expect(res.status).toBe(200);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: GLOBAL_SETTINGS_ID, activeProvider: 'DISABLED', rateLimitMinute: 60, rateLimitHour: 1000 });
    for (const field of ['smtpHost', 'smtpPort', 'smtpUser', 'smtpPass']) {
      expect(rows[0][field] ?? null).toBeNull();
    }
    expect((await res.json()).settings).toMatchObject({ activeProvider: 'DISABLED' });
  });
});

describe('PUT /api/settings stores no SMTP or IMAP settings (L45)', () => {
  it('ignores global SMTP and IMAP fields, which nothing sends or reads with, when creating and updating the row', async () => {
    const legacy = {
      smtpHost: 'smtp.acme.test', smtpPort: 587, smtpUser: 'u', smtpPass: 'smtp-secret',
      imapHost: 'imap.acme.test', imapPort: 993, imapUser: 'u', imapPass: 'imap-secret',
    };

    for (const rateLimitMinute of [30, 40]) {
      const res = await putSettings(makeReq('PUT', { ...legacy, rateLimitMinute }));

      expect(res.status).toBe(200);
      expect(rows).toHaveLength(1);
      expect(rows[0].rateLimitMinute).toBe(rateLimitMinute);
      for (const field of Object.keys(legacy)) expect(rows[0]).not.toHaveProperty(field);
      expect(JSON.stringify(await res.json())).not.toContain('secret');
    }
  });
});

describe('global rate limits show and save only real values (M65)', () => {
  it('accepts null (No Limit) and whole numbers from 1, and rejects empty, zero, negative, fractional, string and oversized values', () => {
    for (const ok of [null, 1, 60, MAX_GLOBAL_RATE_LIMIT]) expect(globalRateLimitError(ok, 'minute')).toBeNull();
    for (const bad of ['', '60', 0, -5, 1.5, Number.NaN, MAX_GLOBAL_RATE_LIMIT + 1, undefined, false]) {
      expect(globalRateLimitError(bad, 'hour')).toMatch(/^Max emails per hour must be a whole number/);
    }
  });

  it('shows a stored limit as that number and a stored null or 0 as No Limit, never as a default', () => {
    expect(rateLimitInputFrom(45)).toEqual({ noLimit: false, text: '45' });
    expect(rateLimitInputFrom(null)).toEqual({ noLimit: true, text: '' });
    expect(rateLimitInputFrom(0)).toEqual({ noLimit: true, text: '' });
  });

  it('reads the form as null only for an explicit No Limit and refuses an empty or invalid field', () => {
    expect(rateLimitInputValue({ noLimit: true, text: '60' }, 'minute')).toEqual({ value: null, error: null });
    expect(rateLimitInputValue({ noLimit: false, text: ' 120 ' }, 'minute')).toEqual({ value: 120, error: null });
    expect(rateLimitInputValue({ noLimit: false, text: '' }, 'minute'))
      .toEqual({ value: null, error: 'Enter the max emails per minute, or choose No Limit.' });
    for (const text of ['0', '-3', '2.5']) {
      expect(rateLimitInputValue({ noLimit: false, text }, 'hour').error).toMatch(/^Max emails per hour must be a whole number/);
    }
  });

  it('returns a stored null as null from GET instead of the 60/1000 defaults', async () => {
    insert({ id: GLOBAL_SETTINGS_ID, activeProvider: 'AZURE', rateLimitMinute: null, rateLimitHour: 250 });

    const res = await getSettings();

    expect((await res.json()).settings).toMatchObject({ rateLimitMinute: null, rateLimitHour: 250 });
  });

  it('refuses an empty, zero or fractional limit with a 400 and leaves the stored limits enforced', async () => {
    insert({ id: GLOBAL_SETTINGS_ID, activeProvider: 'AZURE', rateLimitMinute: 60, rateLimitHour: 1000 });

    for (const body of [{ rateLimitMinute: '' }, { rateLimitMinute: 0 }, { rateLimitHour: 2.5 }, { rateLimitMinute: 30, rateLimitHour: -1 }]) {
      const res = await putSettings(makeReq('PUT', body));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/must be a whole number/);
    }

    expect(mockedPrisma.globalSettings.upsert).not.toHaveBeenCalled();
    expect(rows[0]).toMatchObject({ rateLimitMinute: 60, rateLimitHour: 1000 });
    mockedPrisma.emailDispatch.count.mockResolvedValue(60);
    expect(await checkGlobalRateLimits()).toMatchObject({ allowed: false, reason: expect.stringContaining('Max 60 emails per minute') });
  });

  it('saves an explicit No Limit as null and a positive limit as that number', async () => {
    insert({ id: GLOBAL_SETTINGS_ID, activeProvider: 'AZURE', rateLimitMinute: 60, rateLimitHour: 1000 });

    const res = await putSettings(makeReq('PUT', { rateLimitMinute: null, rateLimitHour: 500 }));

    expect(res.status).toBe(200);
    expect((await res.json()).settings).toMatchObject({ rateLimitMinute: null, rateLimitHour: 500 });
    expect(rows[0]).toMatchObject({ rateLimitMinute: null, rateLimitHour: 500 });
  });
});
