import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * In-memory steps, enrollments and dispatches for one campaign. The fake step
 * model applies the reads and writes PUT /api/campaigns/[id] makes, so the
 * tests check the step rows (ids and stepOrder) a save leaves behind.
 */
const fake = vi.hoisted(() => ({
  campaign: { findUnique: vi.fn(), updateMany: vi.fn() },
  campaignSenderAccount: { deleteMany: vi.fn(), createMany: vi.fn() },
  campaignStep: { findMany: vi.fn(), update: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn() },
  campaignEnrollment: { count: vi.fn(), groupBy: vi.fn() },
  emailDispatch: { count: vi.fn(), findMany: vi.fn(), groupBy: vi.fn() },
  inboundResponse: { count: vi.fn() },
  lead: { count: vi.fn(), groupBy: vi.fn() },
  $transaction: vi.fn(),
  $queryRaw: vi.fn(),
}));

vi.mock('../../lib/db', () => ({
  prisma: fake,
}));

vi.mock('../../lib/session', () => ({
  getSession: vi.fn(),
}));

import { getSession } from '../../lib/session';
import { changesStepStructure, matchStoredSteps, STEP_STRUCTURE_LOCKED_ERROR } from '../../lib/campaignSteps';
import { GET as getCampaign, PUT as putCampaign } from '../../app/api/campaigns/[id]/route';
import { matchesWhere } from './helpers/prismaWhere';

const USER = { id: 'user-1', name: 'User', email: 'user@example.com', role: 'USER' as const };

type StepRow = { id: string; campaignId: string; stepOrder: number; waitDays: number; subject: string; body: string; isABTest: boolean };

let campaign: Record<string, unknown>;
let stepRows: StepRow[];
let enrollments: { campaignId: string; currentSequenceStep: number }[];
let dispatches: { campaignId: string }[];
let nextStepId = 0;

function step(id: string, stepOrder: number, subject: string): StepRow {
  return { id, campaignId: 'cmp-1', stepOrder, waitDays: stepOrder === 1 ? 0 : 3, subject, body: `${subject} body`, isABTest: false };
}

/** Steps as the campaign page holds them: loaded from GET, so with their ids. */
const loaded = () => stepRows.map((s) => ({ ...s }));

/** A step the page's Add Journey Step or Use Template made, with a temporary id. */
const unsaved = (subject: string) => ({ id: `temp-${subject}`, waitDays: 2, subject, body: `${subject} body` });

const orderOf = () => [...stepRows].sort((a, b) => a.stepOrder - b.stepOrder).map((s) => [s.id, s.stepOrder, s.subject]);

const params = { params: Promise.resolve({ id: 'cmp-1' }) };

function makeReq(method: string, body?: unknown): NextRequest {
  return new NextRequest('http://localhost/api/campaigns/cmp-1', {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** A save naming the version it loaded (the stored one). */
const save = (body: Record<string, unknown>) =>
  putCampaign(makeReq('PUT', { updatedAt: (campaign.updatedAt as Date).toISOString(), ...body }), params);

const saveSteps = (steps: unknown[]) => save({ steps });

/** A lead that has moved on to step 2, so the campaign has started. */
function startWithAdvancedLead() {
  enrollments.push({ campaignId: 'cmp-1', currentSequenceStep: 2 });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSession).mockResolvedValue(USER);
  nextStepId = 0;

  campaign = {
    id: 'cmp-1', userId: 'user-1', name: 'Launch', status: 'Active', audienceCohort: 'Valid', senderAccountId: 'mb-1',
    updatedAt: new Date('2026-09-01T10:00:00.000Z'),
  };
  stepRows = [step('step-a', 1, 'A'), step('step-b', 2, 'B'), step('step-c', 3, 'C')];
  enrollments = [{ campaignId: 'cmp-1', currentSequenceStep: 1 }];
  dispatches = [];

  fake.campaign.findUnique.mockImplementation(async ({ include }: any) =>
    include ? { ...campaign, steps: [...stepRows].sort((a, b) => a.stepOrder - b.stepOrder), senders: [] } : { ...campaign },
  );
  fake.campaign.updateMany.mockImplementation(async ({ where, data }: any) => {
    if (!matchesWhere(campaign, where)) return { count: 0 };
    Object.assign(campaign, data);
    return { count: 1 };
  });
  fake.campaignStep.findMany.mockImplementation(async ({ where, orderBy, select }: any) => {
    expect(orderBy).toEqual({ stepOrder: 'asc' });
    return stepRows
      .filter((s) => s.campaignId === where.campaignId)
      .sort((a, b) => a.stepOrder - b.stepOrder)
      .map((s) => (select ? { id: s.id } : { ...s }));
  });
  fake.campaignStep.update.mockImplementation(async ({ where, data }: any) => {
    const row = stepRows.find((s) => s.id === where.id);
    if (!row) throw new Error(`No step ${where.id}`);
    return Object.assign(row, data);
  });
  fake.campaignStep.deleteMany.mockImplementation(async ({ where }: any) => {
    const before = stepRows.length;
    stepRows = stepRows.filter((s) => !(s.campaignId === where.campaignId && where.id.in.includes(s.id)));
    return { count: before - stepRows.length };
  });
  fake.campaignStep.createMany.mockImplementation(async ({ data }: any) => {
    data.forEach((d: any) => stepRows.push({ id: `step-new-${++nextStepId}`, ...d }));
    return { count: data.length };
  });
  fake.campaignEnrollment.count.mockImplementation(async ({ where }: any) =>
    enrollments.filter((e) =>
      e.campaignId === where.campaignId
      && (where.currentSequenceStep === undefined || e.currentSequenceStep > where.currentSequenceStep.gt),
    ).length,
  );
  fake.campaignEnrollment.groupBy.mockResolvedValue([]);
  fake.emailDispatch.count.mockImplementation(async ({ where }: any) =>
    Object.keys(where).length === 1 ? dispatches.filter((d) => d.campaignId === where.campaignId).length : 0,
  );
  fake.emailDispatch.findMany.mockResolvedValue([]);
  fake.emailDispatch.groupBy.mockResolvedValue([]);
  fake.$queryRaw.mockResolvedValue([]);
  fake.inboundResponse.count.mockResolvedValue(0);
  fake.lead.count.mockResolvedValue(0);
  fake.lead.groupBy.mockResolvedValue([]);
  fake.$transaction.mockImplementation(async (fn: (tx: typeof fake) => unknown) => fn(fake));
});

describe('matching saved steps to stored ones (H11)', () => {
  const stored = ['a', 'b', 'c'];

  it('keeps stored steps in place when steps are edited or added at the end', () => {
    expect(matchStoredSteps(stored, [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'temp-1' }])).toEqual(['a', 'b', 'c', null]);
    expect(changesStepStructure(stored, [{ id: 'a' }, { id: 'b' }, { id: 'c' }])).toBe(false);
    expect(changesStepStructure(stored, [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'temp-1' }, {}])).toBe(false);
    expect(changesStepStructure([], [{ id: 'temp-1' }])).toBe(false);
  });

  it.each([
    ['removing the first step', [{ id: 'b' }, { id: 'c' }]],
    ['removing the last step', [{ id: 'a' }, { id: 'b' }]],
    ['reordering', [{ id: 'a' }, { id: 'c' }, { id: 'b' }]],
    ['inserting before a stored step', [{ id: 'a' }, { id: 'temp-1' }, { id: 'b' }, { id: 'c' }]],
    ['replacing every step, as Use Template does', [{ id: 'temp-1' }, { id: 'temp-2' }, { id: 'temp-3' }]],
    ['steps without ids', [{}, {}, {}]],
  ])('flags %s as a structural change', (_label, steps) => {
    expect(changesStepStructure(stored, steps)).toBe(true);
  });

  it('matches a stored id once and ignores ids that are not stored', () => {
    expect(matchStoredSteps(stored, [{ id: 'a' }, { id: 'a' }, { id: 'other-campaign-step' }, null, { id: 7 }])).toEqual(['a', null, null, null, null]);
    expect(changesStepStructure(stored, [{ id: 'a' }, { id: 'a' }, { id: 'b' }, { id: 'c' }])).toBe(true);
  });
});

describe('PUT /api/campaigns/[id] on a campaign that has started sending (H11)', () => {
  it.each([
    ['removing the first step', () => loaded().slice(1)],
    ['reordering steps', () => { const [a, b, c] = loaded(); return [a, c, b]; }],
    ['inserting a step before stored ones', () => { const [a, b, c] = loaded(); return [a, unsaved('X'), b, c]; }],
    ['applying a template', () => [unsaved('T1'), unsaved('T2'), unsaved('T3')]],
  ])('rejects %s with 409 and changes nothing', async (_label, steps) => {
    startWithAdvancedLead();
    const before = structuredClone(stepRows);

    const res = await saveSteps(steps());

    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(STEP_STRUCTURE_LOCKED_ERROR);
    expect(fake.$transaction).not.toHaveBeenCalled();
    expect(stepRows).toEqual(before);
  });

  it('also counts a dispatch as started when no lead is past step 1', async () => {
    dispatches.push({ campaignId: 'cmp-1' });

    const res = await saveSteps(loaded().slice(1));

    expect(res.status).toBe(409);
    expect(orderOf()).toEqual([['step-a', 1, 'A'], ['step-b', 2, 'B'], ['step-c', 3, 'C']]);
  });

  it('edits steps in place and appends new ones, keeping every stored id and stepOrder', async () => {
    startWithAdvancedLead();
    const steps = loaded();
    steps[1].subject = 'B, reworded';
    steps[2].waitDays = 5;

    const res = await saveSteps([...steps, unsaved('D')]);

    expect(res.status).toBe(200);
    expect(fake.campaignStep.deleteMany).not.toHaveBeenCalled();
    expect(orderOf()).toEqual([['step-a', 1, 'A'], ['step-b', 2, 'B, reworded'], ['step-c', 3, 'C'], ['step-new-1', 4, 'D']]);
    expect(stepRows.find((s) => s.id === 'step-c')!.waitDays).toBe(5);
    // The response carries the saved rows, stored ids included.
    expect((await res.json()).steps.map((s: StepRow) => s.id)).toEqual(['step-a', 'step-b', 'step-c', 'step-new-1']);
  });

  it('writes only the step fields, ignoring the stepOrder and campaignId the page sends back', async () => {
    startWithAdvancedLead();
    const steps = loaded().map((s) => ({ ...s, stepOrder: 9, campaignId: 'cmp-other' }));

    expect((await saveSteps(steps)).status).toBe(200);

    expect(orderOf()).toEqual([['step-a', 1, 'A'], ['step-b', 2, 'B'], ['step-c', 3, 'C']]);
    expect(stepRows.every((s) => s.campaignId === 'cmp-1')).toBe(true);
  });

  it('still saves a status change without steps', async () => {
    startWithAdvancedLead();

    const res = await save({ status: 'Paused' });

    expect(res.status).toBe(200);
    expect(campaign.status).toBe('Paused');
    expect(orderOf()).toEqual([['step-a', 1, 'A'], ['step-b', 2, 'B'], ['step-c', 3, 'C']]);
  });
});

describe('PUT /api/campaigns/[id] before a campaign has started sending (H11)', () => {
  it('removes and reorders steps, renumbering them and keeping the ids of the ones kept', async () => {
    const [a, , c] = loaded();

    const res = await saveSteps([c, unsaved('X'), a]);

    expect(res.status).toBe(200);
    expect(fake.campaignStep.deleteMany).toHaveBeenCalledWith({ where: { campaignId: 'cmp-1', id: { in: ['step-b'] } } });
    expect(orderOf()).toEqual([['step-c', 1, 'C'], ['step-new-1', 2, 'X'], ['step-a', 3, 'A']]);
  });

  it('replaces every step when a template is applied', async () => {
    const res = await saveSteps([unsaved('T1'), unsaved('T2')]);

    expect(res.status).toBe(200);
    expect(orderOf()).toEqual([['step-new-1', 1, 'T1'], ['step-new-2', 2, 'T2']]);
  });
});

describe('PUT /api/campaigns/[id] has no A/B test flag (M14)', () => {
  it('ignores an isABTest sent with stored or new steps, since steps have no variants', async () => {
    const steps = loaded().map((s) => ({ ...s, isABTest: true }));

    expect((await saveSteps([...steps, { ...unsaved('D'), isABTest: true }])).status).toBe(200);

    expect(fake.campaignStep.update).toHaveBeenCalledTimes(3);
    for (const [{ data }] of fake.campaignStep.update.mock.calls) expect(data).not.toHaveProperty('isABTest');
    expect(fake.campaignStep.createMany).toHaveBeenCalledTimes(1);
    for (const row of fake.campaignStep.createMany.mock.calls[0][0].data) expect(row).not.toHaveProperty('isABTest');
    expect(stepRows.some((s) => s.isABTest)).toBe(false);
  });
});

describe('GET /api/campaigns/[id] reports whether steps are locked (H11)', () => {
  const stepsLocked = async () => (await (await getCampaign(makeReq('GET'), params)).json()).stepsLocked;

  it('is false while every lead is at step 1 and nothing was sent', async () => {
    expect(await stepsLocked()).toBe(false);
  });

  it('is true once a lead is past step 1 or the campaign has a dispatch', async () => {
    startWithAdvancedLead();
    expect(await stepsLocked()).toBe(true);

    enrollments = [{ campaignId: 'cmp-1', currentSequenceStep: 1 }];
    dispatches.push({ campaignId: 'cmp-1' });
    expect(await stepsLocked()).toBe(true);
  });
});
