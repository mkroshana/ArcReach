import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('../../lib/db', () => ({
  db: {
    getAccounts: vi.fn(),
    getUsers: vi.fn(),
  },
  prisma: {
    template: { findMany: vi.fn() },
  },
}));

vi.mock('../../lib/session', () => ({
  getSession: vi.fn(),
}));

import { db, prisma } from '../../lib/db';
import { getSession } from '../../lib/session';
import { UnauthorizedError } from '../../lib/sessionError';
import { LoadError, loadErrorMessage, readJsonList, readJsonObject, responseErrorMessage } from '../../lib/apiResponse';
import { LONG_TOAST_LENGTH, TOAST_DURATION_MS, toastDuration } from '../../lib/toastDuration';
import { GET as getTemplates } from '../../app/api/templates/route';
import { GET as getAccounts, PUT as putAccount } from '../../app/api/accounts/route';
import { GET as getUsers } from '../../app/api/users/route';

const mockedDb = db as any;
const mockedPrisma = prisma as any;
const mockedSession = vi.mocked(getSession);

const USER = { id: 'user-1', name: 'User', email: 'user@example.com', role: 'USER' as const };

beforeEach(() => {
  vi.clearAllMocks();
  mockedSession.mockResolvedValue(USER);
});

describe('readJsonList turns a failed list load into an error, never an empty list (M69)', () => {
  it('returns the templates the route answers', async () => {
    const rows = [{ id: 't-1', name: 'Intro', subject: 'Hello', body: 'Hi', category: 'Cold Outreach' }];
    mockedPrisma.template.findMany.mockResolvedValue(rows);

    expect(await readJsonList(await getTemplates(), 'Templates')).toEqual(rows);
  });

  it('returns an empty library as an empty list', async () => {
    mockedPrisma.template.findMany.mockResolvedValue([]);

    expect(await readJsonList(await getTemplates(), 'Templates')).toEqual([]);
  });

  it("throws the route's own message when the templates query fails with a 500", async () => {
    mockedPrisma.template.findMany.mockRejectedValue(new Error('Database unreachable.'));
    const res = await getTemplates();
    expect(res.status).toBe(500);

    const failure = readJsonList(res, 'Templates');
    await expect(failure).rejects.toBeInstanceOf(LoadError);
    await expect(failure).rejects.toThrow('Database unreachable.');
  });

  it('throws on the { error } body GET /api/accounts sends when the mailbox query fails, which the Accounts page used to store as its list', async () => {
    mockedDb.getAccounts.mockRejectedValue(new Error('Mailbox query timed out.'));

    await expect(readJsonList(await getAccounts(), 'Mailboxes')).rejects.toThrow('Mailbox query timed out.');
  });

  it('throws when GET /api/users fails, so the Accounts page warns instead of showing every owner as Unknown Team Member', async () => {
    mockedSession.mockResolvedValue({ ...USER, role: 'ADMIN' });
    mockedDb.getUsers.mockRejectedValue(new Error('User query timed out.'));

    await expect(readJsonList(await getUsers(), 'Team members')).rejects.toThrow('User query timed out.');
  });

  it('throws the 401 message when the session has ended', async () => {
    mockedSession.mockRejectedValue(new UnauthorizedError());

    await expect(readJsonList(await getTemplates(), 'Templates')).rejects.toThrow('Your session has ended. Sign in again.');
  });

  it('names the status when a failed response has no JSON error, such as a proxy error page', async () => {
    const res = new Response('<html>Bad Gateway</html>', { status: 502, headers: { 'Content-Type': 'text/html' } });

    await expect(readJsonList(res, 'Sequences')).rejects.toThrow('Sequences could not be loaded (the server answered 502).');
  });

  it('throws when a successful response is not a list', async () => {
    const res = new Response(JSON.stringify({ campaigns: [] }), { status: 200 });

    await expect(readJsonList(res, 'Sequences')).rejects.toThrow('Sequences could not be loaded: the server did not send a list.');
  });
});

describe('readJsonObject', () => {
  it('returns an object body', async () => {
    const res = new Response(JSON.stringify({ stats: { totalSent: 3 } }), { status: 200 });

    expect(await readJsonObject(res, 'Analytics')).toEqual({ stats: { totalSent: 3 } });
  });

  it('throws when a successful response is a list, null or not JSON', async () => {
    for (const body of ['[]', 'null', 'not json']) {
      await expect(readJsonObject(new Response(body, { status: 200 }), 'Analytics')).rejects.toBeInstanceOf(LoadError);
    }
  });

  it("throws the server's message when the request failed", async () => {
    const res = new Response(JSON.stringify({ error: 'Campaign not found.' }), { status: 404 });

    await expect(readJsonObject(res, 'The campaign')).rejects.toThrow('Campaign not found.');
  });
});

describe('responseErrorMessage shows the server error on a refused save (M69)', () => {
  const putReq = (body: unknown) => new NextRequest('http://localhost/api/accounts', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  it("returns the mailbox PUT's 400 message for a cleared daily limit instead of a generic failure", async () => {
    // A cleared Per Day field sends parseInt('') (NaN), which JSON turns into null.
    const res = await putAccount(putReq({ id: 'acc-1', dailyLimit: NaN }));
    expect(res.status).toBe(400);

    expect(await responseErrorMessage(res, 'Autopilot values failed to save.')).toBe('Field "dailyLimit" must be a non-negative integer.');
    expect(mockedDb.getAccounts).not.toHaveBeenCalled();
  });

  it('falls back when the body has no usable error', async () => {
    for (const body of ['', '{}', '{"error":"   "}', '{"error":42}', '<html></html>']) {
      expect(await responseErrorMessage(new Response(body, { status: 500 }), 'Failed to update credentials.')).toBe('Failed to update credentials.');
    }
  });
});

describe('loadErrorMessage', () => {
  it("uses a LoadError's message", () => {
    expect(loadErrorMessage(new LoadError('Campaign not found.'), 'The campaign')).toBe('Campaign not found.');
  });

  it('reports anything else, such as the TypeError fetch rejects with offline, as a connection failure', () => {
    expect(loadErrorMessage(new TypeError('Failed to fetch'), 'Analytics')).toBe('Analytics could not be loaded. Check your connection and try again.');
  });
});

describe('toastDuration keeps long error toasts until dismissed (M69)', () => {
  const long = 'x'.repeat(LONG_TOAST_LENGTH + 1);
  const short = 'x'.repeat(LONG_TOAST_LENGTH);

  it('hides short toasts after the usual time', () => {
    expect(toastDuration(short, 'error')).toBe(TOAST_DURATION_MS);
    expect(toastDuration('Mailbox connected successfully', 'success')).toBe(TOAST_DURATION_MS);
  });

  it('keeps an error longer than the limit until dismissed', () => {
    expect(toastDuration(long, 'error')).toBeNull();
    expect(toastDuration(long, 'error', 3000)).toBeNull();
  });

  it('still hides long success and warning toasts', () => {
    expect(toastDuration(long, 'success')).toBe(TOAST_DURATION_MS);
    expect(toastDuration(long, 'warning', 3000)).toBe(3000);
  });
});
