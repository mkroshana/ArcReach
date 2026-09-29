import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('../../lib/db', () => ({
  db: {
    getCampaigns: vi.fn(),
    updateCampaign: vi.fn(),
    getAccounts: vi.fn(),
    updateAccount: vi.fn(),
  },
  prisma: {
    user: { findUnique: vi.fn() },
    senderAccount: { findUnique: vi.fn() },
  },
}));

vi.mock('../../lib/session', () => ({
  getSession: vi.fn(),
}));

import { db, prisma } from '../../lib/db';
import { getSession } from '../../lib/session';
import { decryptSecret, MASKED_SECRET } from '../../lib/secrets';
import { fieldRules, pickUpdateFields } from '../../lib/updateAllowList';
import { PUT as putCampaign } from '../../app/api/campaigns/route';
import { PUT as putAccount } from '../../app/api/accounts/route';

const mockedDb = db as any;
const mockedPrisma = prisma as any;
const mockedSession = vi.mocked(getSession);

const USER = { id: 'user-1', name: 'User', email: 'user@example.com', role: 'USER' as const };
const ADMIN = { id: 'admin-1', name: 'Admin', email: 'admin@example.com', role: 'ADMIN' as const };

function makeReq(path: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('pickUpdateFields', () => {
  const allowed = { name: fieldRules.nonEmptyString, enabled: fieldRules.boolean, port: fieldRules.port };

  it('passes listed scalar fields through unchanged', () => {
    expect(pickUpdateFields({ name: 'x', enabled: false, port: null }, allowed))
      .toEqual({ ok: true, data: { name: 'x', enabled: false, port: null } });
  });

  it('rejects keys that are not on the allow-list, including prototype names', () => {
    const res = pickUpdateFields(JSON.parse('{"name":"x","user":1,"__proto__":{"a":1},"constructor":2}'), allowed);
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toBe('Unknown field(s): user, __proto__, constructor.');
  });

  it('rejects object and array values for allowed keys', () => {
    const obj = pickUpdateFields({ name: { set: 'x' } }, allowed);
    expect(!obj.ok && obj.error).toMatch(/"name" must be a plain value/);
    const arr = pickUpdateFields({ name: ['x'] }, allowed);
    expect(!arr.ok && arr.error).toMatch(/"name" must be a plain value/);
  });

  it('rejects values of the wrong scalar type', () => {
    expect(pickUpdateFields({ enabled: 'true' }, allowed).ok).toBe(false);
    expect(pickUpdateFields({ port: '587' }, allowed).ok).toBe(false);
    expect(pickUpdateFields({ port: 70000 }, allowed).ok).toBe(false);
    expect(pickUpdateFields({ name: '  ' }, allowed).ok).toBe(false);
    expect(fieldRules.nonNegativeInt.valid(-1)).toBe(false);
    expect(fieldRules.nonNegativeInt.valid(1.5)).toBe(false);
    expect(fieldRules.nonNegativeInt.valid(2_147_483_648)).toBe(false);
  });
});

describe('PUT /api/campaigns', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedSession.mockResolvedValue(USER);
    mockedDb.getCampaigns.mockResolvedValue([{ id: 'cmp-1' }]);
    mockedDb.updateCampaign.mockImplementation(async (id: string, data: any) => ({ id, ...data }));
  });

  it('rejects a nested user write so a USER cannot promote themselves (C1)', async () => {
    const res = await putCampaign(makeReq('/api/campaigns', { id: 'cmp-1', user: { update: { role: 'ADMIN' } } }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Unknown field(s): user.');
    expect(mockedDb.updateCampaign).not.toHaveBeenCalled();
  });

  it('rejects relation connects and server-managed columns', async () => {
    for (const body of [
      { id: 'cmp-1', senderAccount: { connect: { id: 'someone-elses-mailbox' } } },
      { id: 'cmp-1', senderAccountId: 'someone-elses-mailbox' },
      { id: 'cmp-1', pausedUntil: null },
      { id: 'cmp-1', status: { set: 'Active' } },
    ]) {
      const res = await putCampaign(makeReq('/api/campaigns', body));
      expect(res.status).toBe(400);
    }
    expect(mockedDb.updateCampaign).not.toHaveBeenCalled();
  });

  it('rejects a status outside the set the app uses', async () => {
    const res = await putCampaign(makeReq('/api/campaigns', { id: 'cmp-1', status: 'Running' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Field "status" must be one of Draft, Active, Paused.');
  });

  it('writes exactly the status sent by the campaign list toggle', async () => {
    const res = await putCampaign(makeReq('/api/campaigns', { id: 'cmp-1', status: 'Paused' }));
    expect(res.status).toBe(200);
    expect(mockedDb.updateCampaign).toHaveBeenCalledWith('cmp-1', { status: 'Paused' });
  });

  it('keeps the ownership check', async () => {
    const res = await putCampaign(makeReq('/api/campaigns', { id: 'cmp-other', status: 'Active' }));
    expect(res.status).toBe(403);
    expect(mockedDb.updateCampaign).not.toHaveBeenCalled();
  });

  it('drops userId for a USER', async () => {
    const res = await putCampaign(makeReq('/api/campaigns', { id: 'cmp-1', userId: 'user-2', status: 'Active' }));
    expect(res.status).toBe(200);
    expect(mockedDb.updateCampaign).toHaveBeenCalledWith('cmp-1', { status: 'Active' });
    expect(mockedPrisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('lets an ADMIN reassign only to an existing user', async () => {
    mockedSession.mockResolvedValue(ADMIN);

    mockedPrisma.user.findUnique.mockResolvedValue(null);
    const missing = await putCampaign(makeReq('/api/campaigns', { id: 'cmp-1', userId: 'ghost' }));
    expect(missing.status).toBe(400);
    expect(mockedDb.updateCampaign).not.toHaveBeenCalled();

    mockedPrisma.user.findUnique.mockResolvedValue({ id: 'user-2' });
    const ok = await putCampaign(makeReq('/api/campaigns', { id: 'cmp-1', userId: 'user-2' }));
    expect(ok.status).toBe(200);
    expect(mockedPrisma.user.findUnique).toHaveBeenLastCalledWith({ where: { id: 'user-2' }, select: { id: true } });
    expect(mockedDb.updateCampaign).toHaveBeenCalledWith('cmp-1', { userId: 'user-2' });
  });

  it('rejects a non-object body and a non-string id', async () => {
    expect((await putCampaign(makeReq('/api/campaigns', [{ id: 'cmp-1' }]))).status).toBe(400);
    expect((await putCampaign(makeReq('/api/campaigns', { id: { not: 'x' }, status: 'Active' }))).status).toBe(400);
    expect(mockedDb.updateCampaign).not.toHaveBeenCalled();
  });
});

describe('PUT /api/accounts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedSession.mockResolvedValue(USER);
    mockedDb.getAccounts.mockResolvedValue([{ id: 'acc-1' }]);
    mockedPrisma.senderAccount.findUnique.mockResolvedValue({ id: 'acc-1', warmupEnabled: false, warmupStartedAt: null });
    mockedDb.updateAccount.mockImplementation(async (id: string, data: any) => ({ id, ...data }));
  });

  it('rejects a nested user write so a USER cannot promote themselves (C1)', async () => {
    const res = await putAccount(makeReq('/api/accounts', { id: 'acc-1', user: { update: { role: 'ADMIN' } } }));
    expect(res.status).toBe(400);
    expect(mockedDb.updateAccount).not.toHaveBeenCalled();
  });

  it('rejects relation connects and server-managed columns', async () => {
    for (const body of [
      { id: 'acc-1', campaigns: { connect: [{ id: 'cmp-other' }] } },
      { id: 'acc-1', warmupStartedAt: '2020-01-01' },
      { id: 'acc-1', reputationScore: 100 },
      { id: 'acc-1', emailAddress: 'spoof@example.com' },
    ]) {
      const res = await putAccount(makeReq('/api/accounts', body));
      expect(res.status).toBe(400);
    }
    expect(mockedDb.updateAccount).not.toHaveBeenCalled();
  });

  it('rejects wrong types for limits and ports', async () => {
    for (const body of [
      { id: 'acc-1', minuteLimit: null },
      { id: 'acc-1', dailyLimit: '500' },
      { id: 'acc-1', warmupEnabled: 'yes' },
      { id: 'acc-1', smtpPort: '587' },
    ]) {
      const res = await putAccount(makeReq('/api/accounts', body));
      expect(res.status).toBe(400);
    }
    expect(mockedDb.updateAccount).not.toHaveBeenCalled();
  });

  it('writes a warmup toggle and stamps warmupStartedAt on first enable', async () => {
    const res = await putAccount(makeReq('/api/accounts', { id: 'acc-1', warmupEnabled: true }));
    expect(res.status).toBe(200);
    const [, data] = mockedDb.updateAccount.mock.calls[0];
    expect(Object.keys(data).sort()).toEqual(['warmupEnabled', 'warmupStartedAt']);
    expect(data.warmupStartedAt).toBeInstanceOf(Date);
  });

  it('accepts the credentials form payload, skipping masked secrets and encrypting new ones', async () => {
    const res = await putAccount(makeReq('/api/accounts', {
      id: 'acc-1', replyTo: null,
      smtpHost: 'smtp.example.com', smtpPort: 587, smtpUser: 'u', smtpPass: MASKED_SECRET,
      imapHost: null, imapPort: null, imapUser: null, imapPass: 'new-imap-pass',
    }));
    expect(res.status).toBe(200);
    const [id, data] = mockedDb.updateAccount.mock.calls[0];
    expect(id).toBe('acc-1');
    expect(data).not.toHaveProperty('smtpPass');
    expect(data.smtpPort).toBe(587);
    expect(data.imapPort).toBeNull();
    expect(data.imapPass).not.toBe('new-imap-pass');
    expect(decryptSecret(data.imapPass)).toBe('new-imap-pass');
    expect((await res.json()).imapPass).toBe(MASKED_SECRET);
  });

  it('keeps the ownership check', async () => {
    const res = await putAccount(makeReq('/api/accounts', { id: 'acc-other', minuteLimit: 5 }));
    expect(res.status).toBe(403);
    expect(mockedDb.updateAccount).not.toHaveBeenCalled();
  });

  it('drops userId for a USER and requires an existing user for an ADMIN', async () => {
    const userRes = await putAccount(makeReq('/api/accounts', { id: 'acc-1', userId: 'user-2', minuteLimit: 5 }));
    expect(userRes.status).toBe(200);
    expect(mockedDb.updateAccount).toHaveBeenLastCalledWith('acc-1', { minuteLimit: 5 });

    mockedSession.mockResolvedValue(ADMIN);
    mockedPrisma.user.findUnique.mockResolvedValue(null);
    const missing = await putAccount(makeReq('/api/accounts', { id: 'acc-1', userId: 'ghost' }));
    expect(missing.status).toBe(400);

    mockedPrisma.user.findUnique.mockResolvedValue({ id: 'user-2' });
    const ok = await putAccount(makeReq('/api/accounts', { id: 'acc-1', userId: 'user-2' }));
    expect(ok.status).toBe(200);
    expect(mockedDb.updateAccount).toHaveBeenLastCalledWith('acc-1', { userId: 'user-2' });
  });
});
