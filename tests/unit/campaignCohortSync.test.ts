import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * In-memory leads, groups, enrollments and dispatches. The fake models answer
 * the queries the campaign routes and lib/campaignCohort build, so the tests
 * check the enrollment rows a save leaves behind.
 */
const fake = vi.hoisted(() => ({
  campaign: { findUnique: vi.fn(), update: vi.fn() },
  campaignSenderAccount: { deleteMany: vi.fn(), createMany: vi.fn() },
  campaignStep: { deleteMany: vi.fn(), createMany: vi.fn() },
  campaignEnrollment: { count: vi.fn(), findMany: vi.fn(), deleteMany: vi.fn(), updateMany: vi.fn(), createMany: vi.fn() },
  emailDispatch: { findMany: vi.fn() },
  lead: { findMany: vi.fn() },
  leadGroup: { findUnique: vi.fn() },
  senderAccount: { findMany: vi.fn() },
  $transaction: vi.fn(),
}));

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
import { PUT as putCampaign } from '../../app/api/campaigns/[id]/route';

const mockedDb = db as any;
const mockedSession = vi.mocked(getSession);

const USER = { id: 'user-1', name: 'User', email: 'user@example.com', role: 'USER' as const };
const GROUP_IDS = ['g1', 'g2'];

type LeadRow = { id: string; validationStatus: string; isArchived: boolean; groupIds: string[] };
type EnrollmentRow = {
  id: string; leadId: string; campaignId: string; status: string;
  currentSequenceStep: number; nextActionDate: Date | null;
};

let campaign: { id: string; userId: string; status: string; audienceCohort: string; senderAccountId: string };
let leads: LeadRow[];
let enrollments: EnrollmentRow[];
let dispatches: { leadId: string; campaignId: string | null }[];
let nextEnrollmentId = 0;

const DUE = new Date('2026-09-01T09:00:00Z');

function lead(id: string, validationStatus: string, groupIds: string[] = [], isArchived = false): LeadRow {
  return { id, validationStatus, isArchived, groupIds };
}

function enrollment(leadId: string, status: string, currentSequenceStep = 1, campaignId = 'cmp-1'): EnrollmentRow {
  return { id: `env-${leadId}-${campaignId}`, leadId, campaignId, status, currentSequenceStep, nextActionDate: status === 'Active' ? DUE : null };
}

const inList = (value: string, cond: any) => cond === undefined || (typeof cond === 'object' ? cond.in.includes(value) : cond === value);

function enrollmentOf(leadId: string, campaignId = 'cmp-1') {
  return enrollments.find((e) => e.leadId === leadId && e.campaignId === campaignId);
}

function makeReq(method: string, path: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const params = { params: Promise.resolve({ id: 'cmp-1' }) };
const save = (body: Record<string, unknown>) => putCampaign(makeReq('PUT', '/api/campaigns/cmp-1', body), params);

/** What the campaign page sends on every save: the whole form, including the unchanged audience. */
const pageSave = (overrides: Record<string, unknown> = {}) => save({
  name: 'Launch', status: campaign.status, timezone: 'UTC',
  sendSchedule: { days: ['Mon'], window: { start: '09:00', end: '17:00' } },
  stopOnReply: true, trackOpens: true, trackClicks: true,
  audienceCohort: campaign.audienceCohort,
  steps: [{ waitDays: 0, subject: 'Hi', body: 'Hello' }, { waitDays: 3, subject: 'Re: Hi', body: 'Following up' }],
  senderAccountId: 'mb-1', senderAccountIds: ['mb-1'],
  ...overrides,
});

beforeEach(() => {
  vi.resetAllMocks();
  mockedSession.mockResolvedValue(USER);
  nextEnrollmentId = 0;

  campaign = { id: 'cmp-1', userId: 'user-1', status: 'Active', audienceCohort: 'Valid', senderAccountId: 'mb-1' };
  leads = [
    lead('in-both', 'Valid', ['g1']),           // Active mid-sequence, stays in the audience
    lead('never-emailed', 'Valid'),             // Active, due step 1, never sent anything
    lead('mid-sequence', 'Valid'),              // Active at step 2 after step 1 was sent
    lead('hard-bounced', 'Invalid'),            // the engine moved it out of Valid on a hard bounce
    lead('replied', 'Valid'),                   // paused by stopOnReply
    lead('send-failed', 'Risky'),               // exhausted retries
    lead('finished', 'Valid'),                  // completed the sequence
    lead('replied-g1', 'Unverified', ['g1']),   // paused by a reply, and in the new group
    lead('new-g1', 'Valid', ['g1']),            // not enrolled yet
    lead('archived-g1', 'Valid', ['g1'], true), // archived, never enrolled
  ];
  enrollments = [
    enrollment('in-both', 'Active', 2),
    enrollment('never-emailed', 'Active', 1),
    enrollment('mid-sequence', 'Active', 2),
    enrollment('hard-bounced', 'Bounced', 1),
    enrollment('replied', 'Paused', 2),
    enrollment('send-failed', 'Failed', 1),
    enrollment('finished', 'Completed', 2),
    enrollment('replied-g1', 'Paused', 2),
    enrollment('never-emailed', 'Active', 1, 'cmp-2'),
  ];
  dispatches = [
    { leadId: 'in-both', campaignId: 'cmp-1' },
    { leadId: 'mid-sequence', campaignId: 'cmp-1' },
    { leadId: 'hard-bounced', campaignId: 'cmp-1' },
    { leadId: 'replied', campaignId: 'cmp-1' },
    { leadId: 'send-failed', campaignId: 'cmp-1' },
    { leadId: 'finished', campaignId: 'cmp-1' },
    { leadId: 'replied-g1', campaignId: 'cmp-1' },
    { leadId: 'never-emailed', campaignId: 'cmp-2' }, // another campaign's mail does not count
  ];

  fake.campaign.findUnique.mockImplementation(async () => ({ ...campaign }));
  fake.campaign.update.mockImplementation(async ({ data }: any) => {
    campaign = { ...campaign, ...data };
    return campaign;
  });
  fake.senderAccount.findMany.mockImplementation(async ({ where }: any) => where.id.in.map((id: string) => ({ id })));
  fake.leadGroup.findUnique.mockImplementation(async ({ where }: any) => (GROUP_IDS.includes(where.id) ? { id: where.id } : null));
  fake.lead.findMany.mockImplementation(async ({ where }: any) =>
    leads
      .filter((l) => where.isArchived === undefined || l.isArchived === where.isArchived)
      .filter((l) => where.validationStatus === undefined || l.validationStatus === where.validationStatus)
      .filter((l) => where.groups === undefined || l.groupIds.includes(where.groups.some.groupId))
      .map((l) => ({ id: l.id })),
  );
  fake.campaignEnrollment.count.mockImplementation(async ({ where }: any) =>
    enrollments.filter((e) => e.campaignId === where.campaignId).length,
  );
  fake.campaignEnrollment.findMany.mockImplementation(async ({ where }: any) =>
    enrollments
      .filter((e) => e.campaignId === where.campaignId)
      .map(({ id, leadId, status }) => ({ id, leadId, status })),
  );
  fake.campaignEnrollment.deleteMany.mockImplementation(async ({ where }: any) => {
    const before = enrollments.length;
    enrollments = enrollments.filter((e) => !(inList(e.id, where.id) && inList(e.status, where.status)));
    return { count: before - enrollments.length };
  });
  fake.campaignEnrollment.updateMany.mockImplementation(async ({ where, data }: any) => {
    const hit = enrollments.filter((e) => inList(e.id, where.id) && inList(e.status, where.status));
    hit.forEach((e) => Object.assign(e, data));
    return { count: hit.length };
  });
  fake.campaignEnrollment.createMany.mockImplementation(async ({ data }: any) => {
    const fresh = data.filter((d: any) => !enrollmentOf(d.leadId, d.campaignId));
    fresh.forEach((d: any) => enrollments.push({ id: `env-new-${++nextEnrollmentId}`, ...d }));
    return { count: fresh.length };
  });
  fake.emailDispatch.findMany.mockImplementation(async ({ where }: any) => {
    const ids = new Set(
      dispatches.filter((d) => d.campaignId === where.campaignId && where.leadId.in.includes(d.leadId)).map((d) => d.leadId),
    );
    return [...ids].map((leadId) => ({ leadId }));
  });
  fake.$transaction.mockImplementation(async (fn: (tx: typeof fake) => unknown) => fn(fake));
});

describe('saving a campaign without changing its audience (H12)', () => {
  it('pausing from the status dropdown keeps Bounced, Failed and Paused enrollments', async () => {
    const before = structuredClone(enrollments);

    const res = await pageSave({ status: 'Paused' });

    expect(res.status).toBe(200);
    expect(campaign.status).toBe('Paused');
    expect(enrollments).toEqual(before);
    expect(fake.lead.findMany).not.toHaveBeenCalled();
    expect(fake.leadGroup.findUnique).not.toHaveBeenCalled();
  });

  it('does not re-enroll a reply-paused lead that was archived and unarchived between saves', async () => {
    leads.find((l) => l.id === 'replied')!.isArchived = true;
    expect((await pageSave({ name: 'Launch v2' })).status).toBe(200);
    leads.find((l) => l.id === 'replied')!.isArchived = false;
    expect((await pageSave({ name: 'Launch v3' })).status).toBe(200);

    expect(enrollments.filter((e) => e.leadId === 'replied')).toEqual([enrollment('replied', 'Paused', 2)]);
  });

  it('still enrolls the cohort when the campaign has no enrollments yet', async () => {
    enrollments = [];

    const res = await save({ status: 'Active' });

    expect(res.status).toBe(200);
    expect(enrollments.map((e) => e.leadId).sort()).toEqual(['finished', 'in-both', 'mid-sequence', 'never-emailed', 'new-g1', 'replied']);
    for (const e of enrollments) {
      expect(e).toMatchObject({ campaignId: 'cmp-1', status: 'Active', currentSequenceStep: 1 });
    }
  });
});

describe('changing a campaign\'s audience (H12)', () => {
  it('deletes only never-emailed Active enrollments, marks emailed ones Removed and enrolls new members', async () => {
    const res = await pageSave({ audienceCohort: 'g1' });

    expect(res.status).toBe(200);
    expect(campaign.audienceCohort).toBe('g1');

    // Left the audience
    expect(enrollmentOf('never-emailed')).toBeUndefined();
    expect(enrollmentOf('mid-sequence')).toMatchObject({ status: 'Removed', nextActionDate: null, currentSequenceStep: 2 });
    expect(enrollmentOf('hard-bounced')).toEqual(enrollment('hard-bounced', 'Bounced', 1));
    expect(enrollmentOf('replied')).toEqual(enrollment('replied', 'Paused', 2));
    expect(enrollmentOf('send-failed')).toEqual(enrollment('send-failed', 'Failed', 1));
    expect(enrollmentOf('finished')).toEqual(enrollment('finished', 'Completed', 2));

    // Still in the audience, or paused by a reply: untouched
    expect(enrollmentOf('in-both')).toEqual(enrollment('in-both', 'Active', 2));
    expect(enrollmentOf('replied-g1')).toEqual(enrollment('replied-g1', 'Paused', 2));

    // New members
    expect(enrollmentOf('new-g1')).toMatchObject({ status: 'Active', currentSequenceStep: 1 });
    expect(enrollmentOf('archived-g1')).toBeUndefined();

    // Other campaigns are not touched
    expect(enrollmentOf('never-emailed', 'cmp-2')).toEqual(enrollment('never-emailed', 'Active', 1, 'cmp-2'));
  });

  it('switching back does not reactivate Removed or Paused enrollments', async () => {
    expect((await pageSave({ audienceCohort: 'g1' })).status).toBe(200);
    expect((await pageSave({ audienceCohort: 'Valid' })).status).toBe(200);

    expect(enrollmentOf('mid-sequence')).toMatchObject({ status: 'Removed', currentSequenceStep: 2 });
    expect(enrollmentOf('replied')).toEqual(enrollment('replied', 'Paused', 2));
    expect(enrollmentOf('replied-g1')).toEqual(enrollment('replied-g1', 'Paused', 2));
    // Never emailed, so it starts the sequence again as a new member
    expect(enrollmentOf('never-emailed')).toMatchObject({ status: 'Active', currentSequenceStep: 1 });
  });

  it('accepts Unverified, a lead group ID and a group_ prefixed group ID', async () => {
    for (const audienceCohort of ['Unverified', 'g2', 'group_g1']) {
      const res = await save({ audienceCohort });
      expect(res.status).toBe(200);
      expect(campaign.audienceCohort).toBe(audienceCohort);
    }
    expect(fake.leadGroup.findUnique).toHaveBeenCalledWith({ where: { id: 'g1' }, select: { id: true } });
  });
});

describe('audienceCohort validation (L26)', () => {
  it.each([['HighIntent'], ['g-deleted'], [''], ['group_'], [null], [5], [{ id: 'g1' }]])(
    'PUT rejects %j without touching enrollments',
    async (audienceCohort) => {
      const before = structuredClone(enrollments);

      const res = await save({ status: 'Paused', audienceCohort });

      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('audienceCohort must be Valid, Unverified or an existing lead group ID.');
      expect(fake.$transaction).not.toHaveBeenCalled();
      expect(campaign).toMatchObject({ status: 'Active', audienceCohort: 'Valid' });
      expect(enrollments).toEqual(before);
    },
  );

  it('POST rejects an unknown audience before creating the campaign', async () => {
    for (const audienceCohort of ['HighIntent', 'g-deleted', 5]) {
      const res = await postCampaign(makeReq('POST', '/api/campaigns', { name: 'Launch', senderAccountId: 'mb-1', audienceCohort }));
      expect(res.status).toBe(400);
    }
    expect(mockedDb.createCampaign).not.toHaveBeenCalled();
    expect(fake.campaignEnrollment.createMany).not.toHaveBeenCalled();
  });

  it('POST enrolls the members of an existing group', async () => {
    mockedDb.createCampaign.mockImplementation(async (data: any) => ({ id: 'cmp-new', ...data }));

    const res = await postCampaign(makeReq('POST', '/api/campaigns', { name: 'Launch', senderAccountId: 'mb-1', audienceCohort: 'g1' }));

    expect(res.status).toBe(200);
    expect(mockedDb.createCampaign).toHaveBeenCalledWith(expect.objectContaining({ audienceCohort: 'g1' }));
    expect(enrollments.filter((e) => e.campaignId === 'cmp-new').map((e) => e.leadId).sort()).toEqual(['in-both', 'new-g1', 'replied-g1']);
  });
});
