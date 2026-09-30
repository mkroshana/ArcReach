import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const fake = vi.hoisted(() => ({
  campaign: { findUnique: vi.fn(), updateMany: vi.fn() },
  campaignStep: { findMany: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn() },
  campaignSenderAccount: { deleteMany: vi.fn(), createMany: vi.fn() },
  campaignEnrollment: { count: vi.fn(), findMany: vi.fn(), update: vi.fn() },
  emailDispatch: { count: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  senderAccount: { findMany: vi.fn() },
  lead: { findMany: vi.fn() },
  suppressedEmail: { findMany: vi.fn() },
  $transaction: vi.fn(),
}));

vi.mock('../../lib/db', () => ({
  db: { getCampaigns: vi.fn(), updateCampaign: vi.fn(), createCampaign: vi.fn() },
  prisma: fake,
}));

vi.mock('../../lib/session', () => ({
  getSession: vi.fn(),
}));

vi.mock('../../lib/settings', () => ({
  getGlobalSettings: vi.fn(),
}));

vi.mock('../../lib/rateLimits', () => ({
  checkGlobalRateLimits: vi.fn(),
}));

vi.mock('../../lib/emailProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/emailProvider')>()),
  sendMessage: vi.fn(),
}));

import { db } from '../../lib/db';
import { getSession } from '../../lib/session';
import { getGlobalSettings } from '../../lib/settings';
import { checkGlobalRateLimits } from '../../lib/rateLimits';
import { sendMessage } from '../../lib/emailProvider';
import { activationBlocker, findIncompleteSteps } from '../../lib/campaignSteps';
import { matchesWhere } from './helpers/prismaWhere';
import { PUT as putCampaign } from '../../app/api/campaigns/[id]/route';
import { POST as postCampaign, PUT as putCampaignList } from '../../app/api/campaigns/route';
import { POST as postRun } from '../../app/api/campaigns/[id]/run/route';

const mockedDb = db as any;
const mockedSession = vi.mocked(getSession);
const mockedSend = vi.mocked(sendMessage);

const USER = { id: 'user-1', name: 'User', email: 'user@example.com', role: 'USER' as const };

const COMPLETE_STEPS = [
  { stepOrder: 1, waitDays: 0, subject: 'Hi {{firstName}}', body: '<p>Hello there</p>' },
  { stepOrder: 2, waitDays: 3, subject: 'Following up', body: 'Just checking in.' },
];

/** Step 2 is the placeholder "Add Journey Step" leaves: no subject, no body. */
const PLACEHOLDER_STEPS = [COMPLETE_STEPS[0], { stepOrder: 2, waitDays: 3, subject: '', body: '' }];

const SENDER = {
  id: 'mb-1', userId: 'user-1', emailAddress: 'one@acme.test', name: 'One', replyTo: null,
  warmupEnabled: false, warmupStartedAt: null, dailyLimit: 100, warmupLimit: 10, warmupRamp: 5,
};

let campaign: Record<string, unknown>;

const params = { params: Promise.resolve({ id: 'cmp-1' }) };

function makeReq(method: string, path: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** A save from the campaign page, naming the version it loaded (the stored one). */
const save = (body: Record<string, unknown>) =>
  putCampaign(makeReq('PUT', '/api/campaigns/cmp-1', { updatedAt: (campaign.updatedAt as Date).toISOString(), ...body }), params);

function expectNothingSaved() {
  expect(fake.$transaction).not.toHaveBeenCalled();
  expect(fake.campaign.updateMany).not.toHaveBeenCalled();
  expect(fake.campaignStep.deleteMany).not.toHaveBeenCalled();
  expect(fake.campaignStep.createMany).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.resetAllMocks();
  mockedSession.mockResolvedValue(USER);
  campaign = {
    id: 'cmp-1', userId: 'user-1', name: 'Launch', status: 'Draft', audienceCohort: 'Valid',
    timezone: 'UTC', sendSchedule: null, trackOpens: false, trackClicks: false,
    senderAccountId: 'mb-1', senderAccount: SENDER, senders: [], steps: [],
    updatedAt: new Date('2026-09-01T10:00:00.000Z'),
  };
  fake.campaign.findUnique.mockImplementation(async () => ({ ...campaign }));
  fake.campaign.updateMany.mockImplementation(async ({ where, data }: any) => {
    if (!matchesWhere(campaign, where)) return { count: 0 };
    campaign = { ...campaign, ...data };
    return { count: 1 };
  });
  fake.campaignStep.findMany.mockResolvedValue([]);
  fake.campaignEnrollment.count.mockResolvedValue(1);
  fake.$transaction.mockImplementation(async (fn: (tx: typeof fake) => unknown) => fn(fake));
  mockedDb.updateCampaign.mockImplementation(async (id: string, data: any) => ({ id, ...data }));
});

describe('campaign step completeness (H2, H14)', () => {
  it('needs at least one step', () => {
    expect(activationBlocker([])).toBe('Add at least one step with a subject and body before activating this campaign.');
  });

  it('accepts steps with a subject and a plain-text or HTML body', () => {
    expect(activationBlocker(COMPLETE_STEPS)).toBeNull();
  });

  it('flags blank subjects and bodies that are empty once HTML tags are stripped', () => {
    const steps = [
      COMPLETE_STEPS[0],
      { subject: '   ', body: '<p>&nbsp;</p><br/>' },
      { subject: 'Re: Hi', body: '<html><head><style>p { color: red }</style></head><body><div></div></body></html>' },
      { subject: null, body: 'Hello' },
    ];
    expect(findIncompleteSteps(steps)).toEqual([
      { stepNumber: 2, missing: ['subject', 'body'] },
      { stepNumber: 3, missing: ['body'] },
      { stepNumber: 4, missing: ['subject'] },
    ]);
    expect(activationBlocker(steps)).toBe(
      'Step 2 has no subject or body; Step 3 has no body; Step 4 has no subject. Complete every step before activating this campaign.',
    );
  });
});

describe('PUT /api/campaigns/[id] refuses to make a campaign Active with incomplete steps (H2, H14)', () => {
  it('rejects publishing with a placeholder step and saves nothing', async () => {
    const res = await save({ status: 'Active', steps: PLACEHOLDER_STEPS });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Step 2 has no subject or body. Complete every step before activating this campaign.');
    expectNothingSaved();
    expect(campaign.status).toBe('Draft');
  });

  it('rejects publishing a campaign with no steps', async () => {
    const res = await save({ status: 'Active', steps: [] });
    expect(res.status).toBe(400);
    expectNothingSaved();
  });

  it('checks the stored steps when the request does not replace them', async () => {
    const res = await save({ status: 'Active' });

    expect(res.status).toBe(400);
    expect(fake.campaignStep.findMany).toHaveBeenCalledWith({ where: { campaignId: 'cmp-1' }, orderBy: { stepOrder: 'asc' } });
    expectNothingSaved();

    fake.campaignStep.findMany.mockResolvedValue(COMPLETE_STEPS);
    expect((await save({ status: 'Active' })).status).toBe(200);
    expect(campaign.status).toBe('Active');
  });

  it('rejects adding a placeholder step to a campaign that is already Active', async () => {
    campaign.status = 'Active';

    const res = await save({ steps: PLACEHOLDER_STEPS });

    expect(res.status).toBe(400);
    expectNothingSaved();
  });

  it('publishes complete steps', async () => {
    const res = await save({ status: 'Active', steps: COMPLETE_STEPS });

    expect(res.status).toBe(200);
    expect(campaign.status).toBe('Active');
    expect(fake.campaignStep.createMany.mock.calls[0][0].data.map((s: any) => s.subject)).toEqual(['Hi {{firstName}}', 'Following up']);
  });

  it('still saves an incomplete Draft, and pauses an Active campaign whatever its steps', async () => {
    const draft = await save({ status: 'Draft', steps: PLACEHOLDER_STEPS });
    expect(draft.status).toBe(200);
    expect(fake.campaignStep.createMany.mock.calls[0][0].data[1]).toMatchObject({ stepOrder: 2, subject: '', body: '' });

    campaign.status = 'Active';
    const paused = await save({ status: 'Paused', steps: PLACEHOLDER_STEPS });
    expect(paused.status).toBe(200);
    expect(campaign.status).toBe('Paused');
  });
});

describe('PUT /api/campaigns refuses to activate a campaign with incomplete steps (H2, H14)', () => {
  const toggle = (status: string) => putCampaignList(makeReq('PUT', '/api/campaigns', { id: 'cmp-1', status }));

  it.each([
    ['no steps', [], 'Add at least one step with a subject and body before activating this campaign.'],
    ['a placeholder step', PLACEHOLDER_STEPS, 'Step 2 has no subject or body. Complete every step before activating this campaign.'],
  ])('rejects Active with %s', async (_label, steps, error) => {
    mockedDb.getCampaigns.mockResolvedValue([{ id: 'cmp-1', steps }]);

    const res = await toggle('Active');

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(error);
    expect(mockedDb.updateCampaign).not.toHaveBeenCalled();
  });

  it('activates a campaign whose steps are complete, and pauses one whose steps are not', async () => {
    mockedDb.getCampaigns.mockResolvedValue([{ id: 'cmp-1', steps: COMPLETE_STEPS }]);
    expect((await toggle('Active')).status).toBe(200);
    expect(mockedDb.updateCampaign).toHaveBeenLastCalledWith('cmp-1', { status: 'Active', pausedUntil: null, pauseReason: null });

    mockedDb.getCampaigns.mockResolvedValue([{ id: 'cmp-1', steps: [] }]);
    expect((await toggle('Paused')).status).toBe(200);
    expect(mockedDb.updateCampaign).toHaveBeenLastCalledWith('cmp-1', { status: 'Paused', pausedUntil: null, pauseReason: 'user' });
  });
});

describe('POST /api/campaigns creates every campaign as a Draft (H13)', () => {
  const create = (body: Record<string, unknown>) =>
    postCampaign(makeReq('POST', '/api/campaigns', { name: 'Launch', senderAccountId: 'mb-1', ...body }));

  it.each([['Active'], ['Paused'], ['Running'], [null]])('refuses the status %j and creates nothing', async (status) => {
    const res = await create({ status });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('New campaigns start as Draft. Add complete steps, then publish the campaign.');
    expect(mockedDb.createCampaign).not.toHaveBeenCalled();
  });

  it('creates a Draft when the request names Draft or no status', async () => {
    fake.senderAccount.findMany.mockResolvedValue([{ id: 'mb-1' }]);
    fake.lead.findMany.mockResolvedValue([]);
    fake.suppressedEmail.findMany.mockResolvedValue([]);
    mockedDb.createCampaign.mockImplementation(async (data: any) => ({ id: 'cmp-new', ...data }));

    for (const body of [{ status: 'Draft' }, {}]) {
      const res = await create(body);
      expect(res.status).toBe(200);
      expect((await res.json()).status).toBe('Draft');
    }
    expect(mockedDb.createCampaign).toHaveBeenCalledTimes(2);
  });
});

describe('POST /api/campaigns/[id]/run refuses a campaign with no steps (H2)', () => {
  it('returns 400 and leaves every enrollment Active', async () => {
    campaign.status = 'Active';
    vi.mocked(getGlobalSettings).mockResolvedValue({
      id: 'global', activeProvider: 'AZURE', azureConnString: 'enc:v1:conn', azureSenderDomains: ['acme.test'],
    } as any);
    vi.mocked(checkGlobalRateLimits).mockResolvedValue({ allowed: true });
    fake.campaignEnrollment.findMany.mockResolvedValue([
      { id: 'enr-1', campaignId: 'cmp-1', status: 'Active', currentSequenceStep: 1, retryCount: 0, lead: { id: 'lead-1', email: 'lead@prospect.test', name: 'Lead' } },
    ]);
    fake.emailDispatch.count.mockResolvedValue(0);

    const res = await postRun(makeReq('POST', '/api/campaigns/cmp-1/run'), params);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      success: false,
      error: 'This campaign has no steps. Add at least one step with a subject and body before running it.',
    });
    expect(fake.campaignEnrollment.update).not.toHaveBeenCalled();
    expect(fake.emailDispatch.create).not.toHaveBeenCalled();
    expect(mockedSend).not.toHaveBeenCalled();
  });
});
