import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * The campaigns list polls GET /api/campaigns, so it answers with list fields
 * only, and PUT/DELETE check ownership on the one campaign instead of loading
 * the whole list with its stats (M40). The real lib/db and route run against
 * this fake client, which answers a `select` with just the selected columns
 * and relations and a `where` by its id and userId, as Prisma does.
 */
const fake = vi.hoisted(() => {
  const model = (...names: string[]) => Object.fromEntries(names.map((n) => [n, vi.fn()]));
  return {
    user: model('findUnique'),
    campaign: model('findMany', 'findFirst', 'update', 'delete'),
    campaignEnrollment: model('groupBy'),
    emailDispatch: model('groupBy'),
    $queryRaw: vi.fn(),
  };
});

vi.mock('@prisma/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@prisma/client')>()),
  PrismaClient: class {
    constructor() {
      return fake;
    }
  },
}));

vi.mock('../../lib/session', () => ({
  getSession: vi.fn(),
}));

import { getSession } from '../../lib/session';
import { groupRows, matchesWhere } from './helpers/prismaWhere';
import { GET as getCampaigns, PUT as putCampaign, DELETE as deleteCampaign } from '../../app/api/campaigns/route';

const mockedSession = vi.mocked(getSession);

const USER = { id: 'user-1', name: 'User', email: 'user@example.com', role: 'USER' as const };
const ADMIN = { id: 'admin-1', name: 'Admin', email: 'admin@example.com', role: 'ADMIN' as const };

/** A stored step body far larger than anything the list shows. */
const BODY = `<p>${'Hello there, this is the full HTML body. '.repeat(2000)}</p>`;

const MAILBOX = {
  id: 'acc-1', userId: 'user-1', emailAddress: 'sender@example.com', provider: 'AZURE',
  dailyLimit: 500, warmupEnabled: true, imapHost: 'imap.example.com', imapUser: 'sender@example.com',
};

/** Two stored campaigns with every column and relation the list query could reach. */
function storedCampaigns() {
  return [
    {
      id: 'cmp-1', name: 'Launch', status: 'Active', userId: 'user-1', senderAccountId: 'acc-1',
      pausedUntil: null, pauseReason: null, timezone: 'UTC', sendSchedule: { days: ['Mon'], window: { start: '09:00', end: '17:00' } }, audienceCohort: 'Valid',
      stopOnReply: true, trackOpens: true, trackClicks: true,
      createdAt: new Date('2026-09-01T10:00:00.000Z'), updatedAt: new Date('2026-09-02T10:00:00.000Z'),
      user: { id: 'user-1', name: 'User', email: 'user@example.com' },
      senderAccount: MAILBOX,
      senders: [{ campaignId: 'cmp-1', senderAccountId: 'acc-1', senderAccount: MAILBOX }],
      steps: [
        { id: 'step-1', campaignId: 'cmp-1', stepOrder: 1, waitDays: 0, subject: 'Hi {{firstName}}', body: BODY },
        { id: 'step-2', campaignId: 'cmp-1', stepOrder: 2, waitDays: 3, subject: 'Following up', body: BODY },
      ],
    },
    {
      id: 'cmp-2', name: 'Other Owner', status: 'Draft', userId: 'user-2', senderAccountId: 'acc-2',
      pausedUntil: null, pauseReason: null, timezone: 'UTC', sendSchedule: null, audienceCohort: 'Valid',
      stopOnReply: true, trackOpens: true, trackClicks: true,
      createdAt: new Date('2026-09-03T10:00:00.000Z'), updatedAt: new Date('2026-09-03T10:00:00.000Z'),
      user: { id: 'user-2', name: 'Two', email: 'two@example.com' },
      senderAccount: { ...MAILBOX, id: 'acc-2', userId: 'user-2', emailAddress: 'two@example.com' },
      senders: [],
      steps: [],
    },
  ];
}

let campaigns: ReturnType<typeof storedCampaigns>;

/** Only the `select`ed columns of `row`, relations by their own select, as Prisma loads them. */
function selectFrom(row: any, select: Record<string, any>): any {
  if (Array.isArray(row)) return row.map((item) => selectFrom(item, select));
  if (row == null) return row;
  return Object.fromEntries(Object.entries(select).filter(([, on]) => on).map(([key, on]) => {
    if (on === true) return [key, row[key]];
    if (!on.select) throw new Error(`Unmodelled relation load: ${key} ${JSON.stringify(on)}`);
    return [key, selectFrom(row[key], on.select)];
  }));
}

function makeReq(method: string, path: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mockedSession.mockResolvedValue(USER);
  campaigns = storedCampaigns();
  // The dev seed finds its default users, so it creates nothing.
  fake.user.findUnique.mockResolvedValue({ id: 'user-1' });
  fake.campaign.findMany.mockImplementation(async ({ where, select }: any) => {
    if (!select) throw new Error('The campaigns list must select its fields.');
    return campaigns.filter((c) => matchesWhere(c, where)).map((c) => selectFrom(c, select));
  });
  fake.campaign.findFirst.mockImplementation(async ({ where, select }: any) => {
    if (!select) throw new Error('The ownership check must select its fields.');
    const row = campaigns.find((c) => matchesWhere(c, where));
    return row ? selectFrom(row, select) : null;
  });
  fake.campaign.update.mockImplementation(async ({ where, data }: any) => {
    const row = campaigns.find((c) => c.id === where.id)!;
    Object.assign(row, data, { updatedAt: new Date(row.updatedAt.getTime() + 1000) });
    return { ...row };
  });
  fake.campaign.delete.mockImplementation(async ({ where }: any) => {
    campaigns = campaigns.filter((c) => c.id !== where.id);
    return {};
  });
  fake.campaignEnrollment.groupBy.mockResolvedValue([]);
  fake.emailDispatch.groupBy.mockResolvedValue([]);
  fake.$queryRaw.mockResolvedValue([]);
});

describe('GET /api/campaigns returns list fields only (M40)', () => {
  it('ships step metadata without bodies and only the sender address, with the list stats', async () => {
    const res = await getCampaigns();
    expect(res.status).toBe(200);
    const text = await res.text();
    const list = JSON.parse(text);

    expect(list).toHaveLength(1);
    const [campaign] = list;
    expect(campaign.steps).toEqual([
      { id: 'step-1', stepOrder: 1, waitDays: 0, subject: 'Hi {{firstName}}' },
      { id: 'step-2', stepOrder: 2, waitDays: 3, subject: 'Following up' },
    ]);
    expect(campaign.senderAccount).toEqual({ emailAddress: 'sender@example.com' });
    expect(campaign).not.toHaveProperty('senders');
    expect(campaign).toMatchObject({
      id: 'cmp-1', name: 'Launch', status: 'Active', userId: 'user-1', pausedUntil: null, pauseReason: null,
      user: { id: 'user-1', name: 'User', email: 'user@example.com' },
      stepStats: [
        { stepOrder: 1, active: 0, sent: 0, delivered: 0, failed: 0, leads: 0 },
        { stepOrder: 2, active: 0, sent: 0, delivered: 0, failed: 0, leads: 0 },
      ],
      enrollmentSummary: { total: 0, active: 0, completed: 0 },
    });
    expect(text).not.toContain('Hello there');
    expect(text.length).toBeLessThan(2000);
  });

  it('reports the leads each step reached, each once however often it got the step, for its Progress', async () => {
    // Step 1 was sent 5 times, to 3 leads: 2 of them got it twice.
    fake.emailDispatch.groupBy.mockImplementation(async ({ by }: any) =>
      by.includes('status') ? [{ campaignId: 'cmp-1', stepOrder: 1, status: 'Sent', _count: { id: 5 } }] : []);
    fake.$queryRaw.mockResolvedValue([{ campaignId: 'cmp-1', value: 1, leads: 3 }]);

    const [campaign] = await (await getCampaigns()).json();

    expect(campaign.stepStats[0]).toEqual({ stepOrder: 1, active: 0, sent: 5, delivered: 0, reported: 0, failed: 0, leads: 3 });
    expect(campaign.stepStats[1]).toMatchObject({ sent: 0, leads: 0 });
    // One grouped query for every campaign's steps, not one per campaign.
    expect(fake.$queryRaw).toHaveBeenCalledTimes(1);
    expect(fake.$queryRaw.mock.calls[0][0].values).toEqual(['cmp-1']);
  });

  it('reports how many of each step\'s sent emails a delivery report arrived for, so a step with none shows Delivered as unknown, not 0 (stats A1)', async () => {
    const dispatches = [
      // Step 1: a report arrived for one of its two sent emails.
      { id: 'd1', campaignId: 'cmp-1', stepOrder: 1, status: 'Sent', deliveredAt: new Date('2026-09-30T15:00:00Z'), deliveryStatus: 'Delivered' },
      { id: 'd2', campaignId: 'cmp-1', stepOrder: 1, status: 'Sent', deliveredAt: null, deliveryStatus: null },
      // Step 2: sent before delivery reports, so none will arrive; a failed attempt is not a send.
      { id: 'd3', campaignId: 'cmp-1', stepOrder: 2, status: 'Sent', deliveredAt: null, deliveryStatus: null },
      { id: 'd4', campaignId: 'cmp-1', stepOrder: 2, status: 'Failed', deliveredAt: null, deliveryStatus: null },
      // Another user's campaign.
      { id: 'd5', campaignId: 'cmp-2', stepOrder: 1, status: 'Sent', deliveredAt: new Date('2026-09-30T15:00:00Z'), deliveryStatus: 'Delivered' },
    ];
    fake.emailDispatch.groupBy.mockImplementation(async (args: any) => groupRows(dispatches, args));

    const [campaign] = await (await getCampaigns()).json();

    expect(campaign.stepStats.map((s: any) => [s.stepOrder, s.sent, s.delivered, s.reported, s.failed])).toEqual([
      [1, 2, 1, 1, 0],
      [2, 1, 0, 0, 1],
    ]);
  });

  it('lists every campaign for an ADMIN, still without bodies', async () => {
    mockedSession.mockResolvedValue(ADMIN);
    const text = await (await getCampaigns()).text();
    expect(JSON.parse(text).map((c: any) => c.id).sort()).toEqual(['cmp-1', 'cmp-2']);
    expect(text).not.toContain('Hello there');
  });

  it('says whether each campaign has a complete sending schedule, without shipping the schedule or timezone (owner decision)', async () => {
    mockedSession.mockResolvedValue(ADMIN);
    const flags = async () => Object.fromEntries(((await (await getCampaigns()).json()) as any[]).map((c) => {
      expect(c).not.toHaveProperty('sendSchedule');
      expect(c).not.toHaveProperty('timezone');
      return [c.id, c.hasSendingSchedule];
    }));

    expect(await flags()).toEqual({ 'cmp-1': true, 'cmp-2': false });

    campaigns[0].timezone = 'Mars/Olympus_Mons';
    (campaigns[1] as any).sendSchedule = JSON.stringify({ days: ['Tue'], window: { start: '08:00', end: '12:00' } });
    expect(await flags()).toEqual({ 'cmp-1': false, 'cmp-2': true });
  });
});

describe('PUT and DELETE /api/campaigns check ownership on the one campaign (M40)', () => {
  it('activates an owned campaign, checking its stored step bodies, without the list or its stats', async () => {
    const res = await putCampaign(makeReq('PUT', '/api/campaigns', { id: 'cmp-1', status: 'Active' }));
    expect(res.status).toBe(200);
    expect((await res.json()).previousUpdatedAt).toBe('2026-09-02T10:00:00.000Z');
    expect(fake.campaign.findFirst).toHaveBeenCalledTimes(1);
    expect(fake.campaign.findFirst.mock.calls[0][0].where).toEqual({ id: 'cmp-1', userId: 'user-1' });
    expect(fake.campaign.findMany).not.toHaveBeenCalled();
    expect(fake.campaignEnrollment.groupBy).not.toHaveBeenCalled();
    expect(fake.emailDispatch.groupBy).not.toHaveBeenCalled();
  });

  it('still refuses to activate when a stored step has no body', async () => {
    campaigns[0].steps[1].body = '<p></p>';
    const res = await putCampaign(makeReq('PUT', '/api/campaigns', { id: 'cmp-1', status: 'Active' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Step 2 has no body. Complete every step before activating this campaign.');
    expect(fake.campaign.update).not.toHaveBeenCalled();
  });

  it("refuses another user's campaign and an unknown one with 403, and lets an ADMIN change any", async () => {
    for (const id of ['cmp-2', 'cmp-missing']) {
      const res = await putCampaign(makeReq('PUT', '/api/campaigns', { id, status: 'Paused' }));
      expect(res.status).toBe(403);
    }
    expect(fake.campaign.update).not.toHaveBeenCalled();

    mockedSession.mockResolvedValue(ADMIN);
    const res = await putCampaign(makeReq('PUT', '/api/campaigns', { id: 'cmp-2', status: 'Paused' }));
    expect(res.status).toBe(200);
    expect(campaigns[1]).toMatchObject({ status: 'Paused', pauseReason: 'user' });
  });

  it("deletes only the caller's own campaign (an ADMIN's any), without the list or its stats", async () => {
    const refused = await deleteCampaign(makeReq('DELETE', '/api/campaigns?id=cmp-2'));
    expect(refused.status).toBe(403);
    expect(campaigns.map((c) => c.id)).toEqual(['cmp-1', 'cmp-2']);

    const own = await deleteCampaign(makeReq('DELETE', '/api/campaigns?id=cmp-1'));
    expect(own.status).toBe(200);
    expect(campaigns.map((c) => c.id)).toEqual(['cmp-2']);

    mockedSession.mockResolvedValue(ADMIN);
    const admin = await deleteCampaign(makeReq('DELETE', '/api/campaigns?id=cmp-2'));
    expect(admin.status).toBe(200);
    expect(campaigns).toEqual([]);

    expect(fake.campaign.findMany).not.toHaveBeenCalled();
    expect(fake.campaignEnrollment.groupBy).not.toHaveBeenCalled();
  });
});
