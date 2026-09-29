import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/** Every model gets the read and write methods, so a stray write is recorded. */
const fake = vi.hoisted(() => {
  const methods = ['findUnique', 'findMany', 'count', 'groupBy', 'create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany'];
  const model = () => Object.fromEntries(methods.map((n) => [n, vi.fn()]));
  return {
    campaign: model(),
    campaignEnrollment: model(),
    campaignSenderAccount: model(),
    campaignStep: model(),
    emailDispatch: model(),
    inboundResponse: model(),
    lead: model(),
    senderAccount: model(),
    $transaction: vi.fn(),
  };
});

vi.mock('../../lib/db', () => ({
  db: { createCampaign: vi.fn() },
  prisma: fake,
}));

vi.mock('../../lib/session', () => ({
  getSession: vi.fn(),
}));

import { db } from '../../lib/db';
import { getSession } from '../../lib/session';
import { POST as postCampaign } from '../../app/api/campaigns/route';
import { GET as getCampaign, PUT as putCampaign } from '../../app/api/campaigns/[id]/route';

const mockedDb = db as any;
const mockedSession = vi.mocked(getSession);

const WRITES = ['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany'];
const USER = { id: 'user-1', name: 'User', email: 'user@example.com', role: 'USER' as const };
const ADMIN = { id: 'admin-1', name: 'Admin', email: 'admin@example.com', role: 'ADMIN' as const };

/** Published while group g1 was empty, so it has no enrollments yet. */
const CAMPAIGN = {
  id: 'cmp-1', name: 'Launch', userId: 'user-1', status: 'Active', audienceCohort: 'group_g1', senderAccountId: 'mb-1', steps: [],
};

/** Leads later imported into group g1 for a different campaign. */
const GROUP_LEADS = [{ id: 'lead-1' }, { id: 'lead-2' }, { id: 'lead-3' }];

const params = { params: Promise.resolve({ id: 'cmp-1' }) };

function makeReq(method: string, path: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function writeCalls() {
  const calls: string[] = [];
  for (const [name, model] of Object.entries(fake)) {
    if (typeof model === 'function') continue;
    for (const method of WRITES) {
      if (model[method].mock.calls.length > 0) calls.push(`${name}.${method}`);
    }
  }
  if (fake.$transaction.mock.calls.length > 0) calls.push('$transaction');
  return calls;
}

function expectEnrolled(createMany: any, campaignId: string) {
  expect(createMany).toHaveBeenCalledTimes(1);
  const [{ data, skipDuplicates }] = createMany.mock.calls[0];
  expect(skipDuplicates).toBe(true);
  expect(data.map((e: any) => e.leadId)).toEqual(['lead-1', 'lead-2', 'lead-3']);
  for (const e of data) {
    expect(e).toMatchObject({ campaignId, status: 'Active', currentSequenceStep: 1 });
  }
}

beforeEach(() => {
  vi.resetAllMocks();
  mockedSession.mockResolvedValue(USER);
  for (const model of [fake.campaignEnrollment, fake.emailDispatch, fake.inboundResponse, fake.lead]) {
    model.count.mockResolvedValue(0);
    model.groupBy.mockResolvedValue([]);
    model.findMany.mockResolvedValue([]);
  }
  fake.campaign.findUnique.mockResolvedValue(CAMPAIGN);
  fake.lead.findMany.mockImplementation(async ({ where }: any) =>
    where.groups?.some?.groupId === 'g1' ? GROUP_LEADS : [],
  );
  fake.senderAccount.findMany.mockImplementation(async ({ where }: any) =>
    where.id.in.map((id: string) => ({ id })),
  );
  fake.$transaction.mockImplementation(async (fn: (tx: typeof fake) => unknown) => fn(fake));
});

describe('GET /api/campaigns/[id] is read-only (M24)', () => {
  it.each(['GET', 'HEAD'])('%s of a campaign with no enrollments enrolls no one', async (method) => {
    const res = await getCampaign(makeReq(method, '/api/campaigns/cmp-1'), params);
    expect(res.status).toBe(200);
    expect((await res.json()).telemetry.enrollments).toBe(0);
    expect(writeCalls()).toEqual([]);
  });

  it('writes nothing when an ADMIN views another user\'s campaign', async () => {
    mockedSession.mockResolvedValue(ADMIN);
    const res = await getCampaign(makeReq('GET', '/api/campaigns/cmp-1'), params);
    expect(res.status).toBe(200);
    expect(writeCalls()).toEqual([]);
  });

  it('reports the stored enrollment count unchanged', async () => {
    fake.campaignEnrollment.count.mockImplementation(async ({ where }: any) =>
      Object.keys(where).length === 1 ? 7 : 0,
    );
    const res = await getCampaign(makeReq('GET', '/api/campaigns/cmp-1'), params);
    expect((await res.json()).telemetry.enrollments).toBe(7);
    expect(writeCalls()).toEqual([]);
  });
});

describe('explicit create and save still enroll the cohort (M24)', () => {
  it('POST /api/campaigns enrolls the new campaign\'s cohort', async () => {
    mockedDb.createCampaign.mockImplementation(async (data: any) => ({ id: 'cmp-new', ...data }));
    const res = await postCampaign(makeReq('POST', '/api/campaigns', {
      name: 'Launch', senderAccountId: 'mb-1', audienceCohort: 'group_g1',
    }));
    expect(res.status).toBe(200);
    expectEnrolled(fake.campaignEnrollment.createMany, 'cmp-new');
  });

  it('PUT /api/campaigns/[id] enrolls the cohort on save or publish', async () => {
    const res = await putCampaign(makeReq('PUT', '/api/campaigns/cmp-1', { status: 'Active' }), params);
    expect(res.status).toBe(200);
    expectEnrolled(fake.campaignEnrollment.createMany, 'cmp-1');
  });
});
