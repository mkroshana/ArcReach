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
    senderAccount: { findUnique: vi.fn(), findMany: vi.fn() },
    lead: { update: vi.fn(), updateMany: vi.fn(), findMany: vi.fn() },
    leadGroupMembership: { findMany: vi.fn() },
    leadGroup: { findMany: vi.fn() },
    campaignEnrollment: { updateMany: vi.fn() },
    suppressedEmail: { findMany: vi.fn() },
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
import { PUT as putLead } from '../../app/api/leads/route';
import { getEffectiveDailyCap } from '../../lib/sendEngine';

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
    mockedDb.getCampaigns.mockResolvedValue([
      { id: 'cmp-1', userId: 'user-1', senderAccountId: 'mb-1', senders: [], steps: [{ stepOrder: 1, subject: 'Hi', body: 'Hello' }] },
    ]);
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

  it('writes exactly the status sent by the campaign list toggle, clearing any auto-resume (H8)', async () => {
    const res = await putCampaign(makeReq('/api/campaigns', { id: 'cmp-1', status: 'Paused' }));
    expect(res.status).toBe(200);
    expect(mockedDb.updateCampaign).toHaveBeenCalledWith('cmp-1', { status: 'Paused', pausedUntil: null, pauseReason: 'user' });
  });

  it('keeps the ownership check', async () => {
    const res = await putCampaign(makeReq('/api/campaigns', { id: 'cmp-other', status: 'Active' }));
    expect(res.status).toBe(403);
    expect(mockedDb.updateCampaign).not.toHaveBeenCalled();
  });

  it('drops userId for a USER', async () => {
    const res = await putCampaign(makeReq('/api/campaigns', { id: 'cmp-1', userId: 'user-2', status: 'Active' }));
    expect(res.status).toBe(200);
    expect(mockedDb.updateCampaign).toHaveBeenCalledWith('cmp-1', { status: 'Active', pausedUntil: null, pauseReason: null });
    expect(mockedPrisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('lets an ADMIN reassign only to an existing user', async () => {
    mockedSession.mockResolvedValue(ADMIN);

    mockedPrisma.user.findUnique.mockResolvedValue(null);
    const missing = await putCampaign(makeReq('/api/campaigns', { id: 'cmp-1', userId: 'ghost' }));
    expect(missing.status).toBe(400);
    expect(mockedDb.updateCampaign).not.toHaveBeenCalled();

    mockedPrisma.user.findUnique.mockResolvedValue({ id: 'user-2' });
    // user-2 owns the campaign's sender mailbox, which a reassignment requires (H24).
    mockedPrisma.senderAccount.findMany.mockResolvedValue([{ id: 'mb-1' }]);
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
      { id: 'acc-1', warmupSent: 0 },
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
    expect(Object.keys(data).sort()).toEqual(['warmupEnabled', 'warmupSent', 'warmupStartedAt']);
    expect(data.warmupStartedAt).toBeInstanceOf(Date);
    expect(data.warmupSent).toBe(0);
  });

  it('restarts the ramp at Day 1 when warmup is turned back on (M12)', async () => {
    const paused = {
      id: 'acc-1', warmupEnabled: false, warmupStartedAt: new Date('2025-01-15T09:00:00Z'), warmupSent: 3000,
      dailyLimit: 500, warmupLimit: 50, warmupRamp: 2,
    };
    mockedPrisma.senderAccount.findUnique.mockResolvedValue(paused);
    const before = Date.now();
    const res = await putAccount(makeReq('/api/accounts', { id: 'acc-1', warmupEnabled: true }));
    expect(res.status).toBe(200);
    const [, data] = mockedDb.updateAccount.mock.calls[0];
    expect(data.warmupStartedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(data.warmupSent).toBe(0);
    // Resuming from the old start date would count the months with warmup off as ramp days;
    // after the reset the engine caps the mailbox at its Day 1 volume.
    expect(getEffectiveDailyCap({ ...paused, warmupEnabled: true }, new Date())).toBeGreaterThan(50);
    expect(getEffectiveDailyCap({ ...paused, ...data }, new Date())).toBe(50);
    expect((await res.json()).warmupSent).toBe(0);
  });

  it('keeps the ramp when warmup is already on or is turned off', async () => {
    mockedPrisma.senderAccount.findUnique.mockResolvedValue({
      id: 'acc-1', warmupEnabled: true, warmupStartedAt: new Date('2026-06-01T12:00:00Z'), warmupSent: 40,
    });
    await putAccount(makeReq('/api/accounts', { id: 'acc-1', warmupEnabled: true, warmupLimit: 60 }));
    expect(mockedDb.updateAccount).toHaveBeenLastCalledWith('acc-1', { warmupEnabled: true, warmupLimit: 60 });
    await putAccount(makeReq('/api/accounts', { id: 'acc-1', warmupEnabled: false }));
    expect(mockedDb.updateAccount).toHaveBeenLastCalledWith('acc-1', { warmupEnabled: false });
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

  it('resets the IMAP reply-sync checkpoint only when the IMAP host or login changes (H32)', async () => {
    mockedPrisma.senderAccount.findUnique.mockResolvedValue({
      id: 'acc-1', warmupEnabled: false, imapHost: 'imap.old.test', imapPort: 993, imapUser: 'sales@old.test', imapUidValidity: 7, imapLastUid: 900,
    });

    const same = { imapHost: 'imap.old.test', imapPort: 993, imapUser: 'sales@old.test' };
    expect((await putAccount(makeReq('/api/accounts', { id: 'acc-1', ...same }))).status).toBe(200);
    expect(mockedDb.updateAccount).toHaveBeenLastCalledWith('acc-1', same);

    for (const change of [{ imapHost: 'imap.new.test' }, { imapUser: 'other@old.test' }, { imapHost: null }]) {
      expect((await putAccount(makeReq('/api/accounts', { id: 'acc-1', ...change }))).status).toBe(200);
      expect(mockedDb.updateAccount).toHaveBeenLastCalledWith('acc-1', {
        ...change, imapUidValidity: null, imapLastUid: null, imapFailedUid: null, imapFailedUidAttempts: 0, imapLastSyncAt: null, imapLastSyncError: null,
      });
    }

    // The checkpoint itself is server-managed.
    mockedDb.updateAccount.mockClear();
    expect((await putAccount(makeReq('/api/accounts', { id: 'acc-1', imapLastUid: 0 }))).status).toBe(400);
    expect(mockedDb.updateAccount).not.toHaveBeenCalled();
  });

  it('resets the reply-sync status when any IMAP connection detail changes, and only then (M57)', async () => {
    mockedPrisma.senderAccount.findUnique.mockResolvedValue({
      id: 'acc-1', warmupEnabled: false, imapHost: 'imap.old.test', imapPort: 993, imapUser: 'sales@old.test',
      imapPass: 'enc:v1:stored', imapAllowSelfSigned: false,
      imapLastSyncAt: new Date('2026-09-29T10:00:00Z'), imapLastSyncError: 'Login refused by imap.old.test: NO. Check the IMAP username and password.',
    });

    // The credentials form sends every field back, the password as the mask, when only Reply-To changed.
    const unchanged = { replyTo: 'replies@old.test', imapHost: 'imap.old.test', imapPort: 993, imapUser: 'sales@old.test', imapPass: MASKED_SECRET, imapAllowSelfSigned: false };
    expect((await putAccount(makeReq('/api/accounts', { id: 'acc-1', ...unchanged }))).status).toBe(200);
    const [, kept] = mockedDb.updateAccount.mock.lastCall;
    expect(kept).not.toHaveProperty('imapLastSyncAt');
    expect(kept).not.toHaveProperty('imapLastSyncError');

    for (const change of [{ imapPort: 143 }, { imapPass: 'new-app-password' }, { imapAllowSelfSigned: true }, { imapHost: 'imap.new.test' }]) {
      expect((await putAccount(makeReq('/api/accounts', { id: 'acc-1', ...unchanged, ...change }))).status).toBe(200);
      expect(mockedDb.updateAccount.mock.lastCall[1]).toMatchObject({ imapLastSyncAt: null, imapLastSyncError: null });
    }

    // The status itself is server-managed.
    mockedDb.updateAccount.mockClear();
    expect((await putAccount(makeReq('/api/accounts', { id: 'acc-1', imapLastSyncError: null }))).status).toBe(400);
    expect((await putAccount(makeReq('/api/accounts', { id: 'acc-1', imapLastSyncAt: '2026-09-30T00:00:00Z' }))).status).toBe(400);
    expect(mockedDb.updateAccount).not.toHaveBeenCalled();
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

describe('PUT /api/leads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedSession.mockResolvedValue(USER);
    mockedPrisma.lead.update.mockImplementation(async ({ where, data }: any) => ({ id: where.id, ...data }));
    mockedPrisma.lead.updateMany.mockResolvedValue({ count: 2 });
    mockedPrisma.leadGroupMembership.findMany.mockResolvedValue([{ leadId: 'lead-1' }, { leadId: 'lead-2' }]);
    // Groups g-1 and g-2 exist.
    mockedPrisma.leadGroup.findMany.mockImplementation(async ({ where }: any) =>
      where.id.in.filter((id: string) => ['g-1', 'g-2'].includes(id)).map((id: string) => ({ id })));
    mockedPrisma.campaignEnrollment.updateMany.mockResolvedValue({ count: 0 });
    // Neither lead is on the suppression list, and both may be emailed.
    mockedPrisma.lead.findMany.mockResolvedValue([{ id: 'lead-1', email: 'one@example.com' }, { id: 'lead-2', email: 'two@example.com' }]);
    mockedPrisma.suppressedEmail.findMany.mockResolvedValue([]);
  });

  function expectNoWrites() {
    expect(mockedPrisma.lead.update).not.toHaveBeenCalled();
    expect(mockedPrisma.lead.updateMany).not.toHaveBeenCalled();
    expect(mockedPrisma.campaignEnrollment.updateMany).not.toHaveBeenCalled();
  }

  it('rejects nested writes through dispatches to the owning user (C2)', async () => {
    const wipe = await putLead(makeReq('/api/leads', { id: 'lead-1', dispatches: { deleteMany: {} } }));
    expect(wipe.status).toBe(400);
    expect((await wipe.json()).error).toBe('Unknown field(s): dispatches.');

    const escalate = await putLead(makeReq('/api/leads', {
      id: 'lead-1',
      dispatches: { update: { where: { id: 'd-1' }, data: { campaign: { update: { user: { update: { role: 'ADMIN' } } } } } } },
    }));
    expect(escalate.status).toBe(400);
    expectNoWrites();
  });

  it('rejects email, relation and JSON columns', async () => {
    for (const body of [
      { id: 'lead-1', email: 'someone@example.com' },
      { id: 'lead-1', customVariables: { a: 1 } },
      { id: 'lead-1', enrollments: { deleteMany: {} } },
      { id: 'lead-1', groups: { create: [{ groupId: 'g-1' }] } },
      { id: 'lead-1', replies: { deleteMany: {} } },
    ]) {
      const res = await putLead(makeReq('/api/leads', body));
      expect(res.status).toBe(400);
    }
    expectNoWrites();
  });

  it('rejects object values and values outside the lead enums', async () => {
    for (const body of [
      { id: 'lead-1', status: { set: 'Neutral' } },
      { id: 'lead-1', status: 'Active' },
      // Set only with a suppression, never by an edit (H17)
      { id: 'lead-1', status: 'Unsubscribed' },
      { ids: ['lead-1'], status: 'Bounced' },
      { id: 'lead-1', validationStatus: 'Verified' },
      { id: 'lead-1', isArchived: 'true' },
      { id: 'lead-1', name: 5 },
      { id: 'lead-1', company: ['Acme'] },
    ]) {
      const res = await putLead(makeReq('/api/leads', body));
      expect(res.status).toBe(400);
    }
    const res = await putLead(makeReq('/api/leads', { id: 'lead-1', validationStatus: 'Verified' }));
    expect((await res.json()).error).toBe('Field "validationStatus" must be one of Valid, Invalid, Risky, Unverified.');
    expectNoWrites();
  });

  it('applies the same allow-list to the ids and groupId bulk updates', async () => {
    for (const body of [
      { ids: ['lead-1'], dispatches: { deleteMany: {} } },
      { ids: ['lead-1'], email: 'someone@example.com' },
      { groupId: 'g-1', dispatches: { deleteMany: {} } },
      { groupId: 'g-1', status: { set: 'Neutral' } },
    ]) {
      const res = await putLead(makeReq('/api/leads', body));
      expect(res.status).toBe(400);
    }
    expectNoWrites();
    expect(mockedPrisma.leadGroupMembership.findMany).not.toHaveBeenCalled();
  });

  it('rejects filter objects and non-string ids in place of lead and group IDs', async () => {
    for (const body of [
      [{ id: 'lead-1', isArchived: true }],
      { id: { not: 'x' }, isArchived: true },
      { ids: 'lead-1', isArchived: true },
      { ids: [{ not: 'x' }], isArchived: true },
      { groupId: { not: 'g-1' }, isArchived: true },
      { id: 'lead-1', groupIds: [{ id: 'g-1' }] },
      { id: 'lead-1', groupIds: 'g-1' },
      { ids: ['lead-1'], groupIds: ['g-1'] },
      { isArchived: true },
    ]) {
      const res = await putLead(makeReq('/api/leads', body));
      expect(res.status).toBe(400);
    }
    expectNoWrites();
    expect(mockedPrisma.leadGroupMembership.findMany).not.toHaveBeenCalled();
  });

  it('writes exactly the archive toggle sent by the leads page', async () => {
    const res = await putLead(makeReq('/api/leads', { id: 'lead-1', isArchived: true }));
    expect(res.status).toBe(200);
    expect(mockedPrisma.lead.update).toHaveBeenCalledWith({
      where: { id: 'lead-1' },
      data: { isArchived: true },
      include: { groups: { include: { group: true } } },
    });
    expect(mockedPrisma.campaignEnrollment.updateMany).not.toHaveBeenCalled();
  });

  it('replaces group memberships from groupIds on a single lead', async () => {
    const res = await putLead(makeReq('/api/leads', { id: 'lead-1', groupIds: ['g-1', 'g-2'] }));
    expect(res.status).toBe(200);
    const [{ data }] = mockedPrisma.lead.update.mock.calls[0];
    expect(data).toEqual({ groups: { deleteMany: {}, create: [{ groupId: 'g-1' }, { groupId: 'g-2' }] } });
  });

  it('refuses groupIds naming a group that does not exist with a 400 instead of failing the write', async () => {
    const res = await putLead(makeReq('/api/leads', { id: 'lead-1', groupIds: ['g-1', 'deleted-group', 'ghost'] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Unknown lead group ID(s): deleted-group, ghost.');
    expect(mockedPrisma.leadGroup.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['g-1', 'deleted-group', 'ghost'] } },
      select: { id: true },
    });
    expectNoWrites();
  });

  it('writes a group named twice in groupIds once', async () => {
    const res = await putLead(makeReq('/api/leads', { id: 'lead-1', groupIds: ['g-1', 'g-2', 'g-1'] }));
    expect(res.status).toBe(200);
    const [{ data }] = mockedPrisma.lead.update.mock.calls[0];
    expect(data.groups.create).toEqual([{ groupId: 'g-1' }, { groupId: 'g-2' }]);
  });

  it('clears every membership for an empty groupIds without looking groups up', async () => {
    const res = await putLead(makeReq('/api/leads', { id: 'lead-1', groupIds: [] }));
    expect(res.status).toBe(200);
    expect(mockedPrisma.leadGroup.findMany).not.toHaveBeenCalled();
    const [{ data }] = mockedPrisma.lead.update.mock.calls[0];
    expect(data).toEqual({ groups: { deleteMany: {}, create: [] } });
  });

  it('keeps bulk re-activation resetting bounced and failed enrollments', async () => {
    const res = await putLead(makeReq('/api/leads', { ids: ['lead-1', 'lead-2'], status: 'Neutral', validationStatus: 'Valid' }));
    expect(res.status).toBe(200);
    expect(mockedPrisma.lead.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['lead-1', 'lead-2'] } },
      data: { status: 'Neutral', validationStatus: 'Valid' },
    });
    const [{ where, data }] = mockedPrisma.campaignEnrollment.updateMany.mock.calls[0];
    expect(where).toEqual({ leadId: { in: ['lead-1', 'lead-2'] }, status: { in: ['Bounced', 'Failed'] } });
    expect(data.status).toBe('Active');
  });

  it('archives every lead in a group with only the archive flag', async () => {
    const res = await putLead(makeReq('/api/leads', { groupId: 'g-1', isArchived: true }));
    expect(res.status).toBe(200);
    expect(mockedPrisma.leadGroupMembership.findMany).toHaveBeenCalledWith({ where: { groupId: 'g-1' }, select: { leadId: true } });
    expect(mockedPrisma.lead.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['lead-1', 'lead-2'] } },
      data: { isArchived: true },
    });
    expect(mockedPrisma.campaignEnrollment.updateMany).not.toHaveBeenCalled();
  });
});
