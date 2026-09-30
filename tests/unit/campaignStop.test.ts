import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * Stopping and restarting a campaign through the collection PUT, and what a
 * stopped campaign refuses. Every model gets write methods so a test sees any
 * stray write: stopping must change the campaign only, never its enrollments.
 */
const fake = vi.hoisted(() => {
  const methods = ['findUnique', 'findFirst', 'findMany', 'count', 'create', 'createMany', 'update', 'updateMany', 'delete', 'deleteMany'];
  const model = () => Object.fromEntries(methods.map((n) => [n, vi.fn()]));
  return {
    campaign: model(),
    campaignStep: model(),
    campaignSenderAccount: model(),
    campaignEnrollment: model(),
    emailDispatch: model(),
    user: model(),
    $transaction: vi.fn(),
  };
});

vi.mock('../../lib/db', () => ({
  db: { updateCampaign: vi.fn() },
  prisma: fake,
}));

vi.mock('../../lib/session', () => ({
  getSession: vi.fn(),
}));

vi.mock('../../lib/settings', () => ({
  getGlobalSettings: vi.fn(),
}));

import { db } from '../../lib/db';
import { getSession } from '../../lib/session';
import { getGlobalSettings } from '../../lib/settings';
import { CAMPAIGN_OWNER_DISABLED_ERROR } from '../../lib/campaignPause';
import {
  CAMPAIGN_STOPPED_ERROR, NOT_STOPPABLE_ERROR, isStopped, restartConfirmMessage, stopChangeError, stopConfirmMessage,
  stoppedAtChange, stoppedNote,
} from '../../lib/campaignStop';
import { SCHEDULE_REQUIRED_ERROR } from '../../lib/sendSchedule';
import { PUT as putCampaignList } from '../../app/api/campaigns/route';
import { PUT as putCampaign } from '../../app/api/campaigns/[id]/route';
import { POST as postRun } from '../../app/api/campaigns/[id]/run/route';

const mockedDb = db as any;
const mockedSession = vi.mocked(getSession);

const USER = { id: 'user-1', name: 'User', email: 'user@example.com', role: 'USER' as const };
const ADMIN = { id: 'admin-1', name: 'Admin', email: 'admin@example.com', role: 'ADMIN' as const };
const COMPLETE_STEPS = [
  { stepOrder: 1, waitDays: 0, subject: 'Hi {{firstName}}', body: '<p>Hello there</p>' },
  { stepOrder: 2, waitDays: 3, subject: 'Following up', body: 'Just checking in.' },
];
const OFFICE_HOURS = { days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], window: { start: '09:00', end: '17:00' } };
const STOPPED_AT = new Date('2026-09-30T13:02:00.000Z');

let campaign: Record<string, any>;

const params = { params: Promise.resolve({ id: 'cmp-1' }) };

function makeReq(method: string, path: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** The collection PUT, as the Stop, Restart, Pause and Activate buttons and the status menu send it. */
const change = (body: Record<string, unknown>) => putCampaignList(makeReq('PUT', '/api/campaigns', { id: 'cmp-1', ...body }));

/** Every write any model received. */
function writes() {
  return Object.entries(fake).flatMap(([name, model]) =>
    typeof model === 'function' ? [] : Object.entries(model)
      .filter(([method, fn]) => !method.startsWith('find') && method !== 'count' && (fn as any).mock.calls.length > 0)
      .map(([method]) => `${name}.${method}`));
}

beforeEach(() => {
  vi.resetAllMocks();
  mockedSession.mockResolvedValue(USER);
  campaign = {
    id: 'cmp-1', userId: 'user-1', name: 'Launch', status: 'Active', audienceCohort: 'Valid',
    pausedUntil: null, pauseReason: null, stoppedAt: null,
    timezone: 'UTC', sendSchedule: OFFICE_HOURS, user: { disabledAt: null },
    senderAccountId: 'mb-1', senderAccount: { emailAddress: 'one@acme.test' }, senders: [], steps: COMPLETE_STEPS,
    updatedAt: new Date('2026-09-01T10:00:00.000Z'),
  };
  // Both routes read the stored campaign; the collection PUT's read carries its steps and owner.
  fake.campaign.findFirst.mockImplementation(async () => ({ ...campaign }));
  fake.campaign.findUnique.mockImplementation(async () => ({ ...campaign }));
  mockedDb.updateCampaign.mockImplementation(async (_id: string, data: any) => {
    campaign = { ...campaign, ...data, updatedAt: new Date(campaign.updatedAt.getTime() + 1000) };
    return { ...campaign };
  });
});

describe('stopping a campaign', () => {
  it('stops an Active campaign, recording when, and never touches its enrollments', async () => {
    const before = Date.now();
    const res = await change({ status: 'Stopped' });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ status: 'Stopped', pausedUntil: null, pauseReason: null });
    expect(new Date(body.stoppedAt).getTime()).toBeGreaterThanOrEqual(before);
    expect(mockedDb.updateCampaign).toHaveBeenCalledWith('cmp-1', {
      status: 'Stopped', pausedUntil: null, pauseReason: null, stoppedAt: expect.any(Date),
    });
    expect(writes()).toEqual([]);
  });

  it('stops a Paused campaign and cancels the auto-resume the send engine scheduled', async () => {
    campaign = { ...campaign, status: 'Paused', pausedUntil: new Date('2026-09-30T15:00:00.000Z'), pauseReason: 'quota' };

    expect((await change({ status: 'Stopped' })).status).toBe(200);
    expect(campaign).toMatchObject({ status: 'Stopped', pausedUntil: null, pauseReason: null });
    expect(campaign.stoppedAt).toBeInstanceOf(Date);
  });

  it('stops a campaign paused because its owner is disabled, which still may not be restarted', async () => {
    mockedSession.mockResolvedValue(ADMIN);
    campaign = { ...campaign, status: 'Paused', pauseReason: 'owner_disabled', user: { disabledAt: new Date('2026-09-29T08:00:00.000Z') } };

    expect((await change({ status: 'Stopped' })).status).toBe(200);
    expect(campaign.status).toBe('Stopped');

    const restart = await change({ status: 'Active' });
    expect(restart.status).toBe(409);
    expect((await restart.json()).error).toBe(CAMPAIGN_OWNER_DISABLED_ERROR);
    expect(campaign.status).toBe('Stopped');
  });

  it('refuses to stop a Draft with 409 and writes nothing', async () => {
    campaign.status = 'Draft';

    const res = await change({ status: 'Stopped' });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: NOT_STOPPABLE_ERROR });
    expect(mockedDb.updateCampaign).not.toHaveBeenCalled();
    expect(campaign.status).toBe('Draft');
  });

  it("refuses another user's campaign with 403", async () => {
    fake.campaign.findFirst.mockResolvedValue(null);

    expect((await change({ status: 'Stopped' })).status).toBe(403);
    expect(mockedDb.updateCampaign).not.toHaveBeenCalled();
  });
});

describe('a stopped campaign is read-only until it is restarted', () => {
  beforeEach(() => {
    campaign = { ...campaign, status: 'Stopped', stoppedAt: STOPPED_AT };
  });

  it.each([
    ['Stopped again', { status: 'Stopped' }],
    ['Paused', { status: 'Paused' }],
    ['Draft', { status: 'Draft' }],
    ['a rename', { name: 'Renamed' }],
    ['a new owner', { userId: 'user-2' }],
    ['tracking flags', { trackOpens: false }],
    ['a restart with another change', { status: 'Active', name: 'Renamed' }],
  ])('refuses %s from the collection PUT with 409', async (_label, body) => {
    mockedSession.mockResolvedValue(ADMIN);

    const res = await change(body);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: CAMPAIGN_STOPPED_ERROR });
    expect(mockedDb.updateCampaign).not.toHaveBeenCalled();
    expect(campaign).toMatchObject({ status: 'Stopped', stoppedAt: STOPPED_AT, name: 'Launch' });
  });

  it('refuses a save from the campaign page with 409 and saves nothing', async () => {
    const res = await putCampaign(makeReq('PUT', '/api/campaigns/cmp-1', {
      updatedAt: campaign.updatedAt.toISOString(), name: 'Renamed', steps: COMPLETE_STEPS,
    }), params);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: CAMPAIGN_STOPPED_ERROR });
    expect(fake.$transaction).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
  });

  it('refuses Publish Sequence from the campaign page too', async () => {
    const res = await putCampaign(makeReq('PUT', '/api/campaigns/cmp-1', {
      updatedAt: campaign.updatedAt.toISOString(), status: 'Active', steps: COMPLETE_STEPS,
    }), params);

    expect(res.status).toBe(409);
    expect(campaign.status).toBe('Stopped');
  });

  it.each([['Run Now', ''], ['Send Step', '?stepOrder=1']])('refuses %s with 409 and queues nothing', async (_label, query) => {
    const res = await postRun(makeReq('POST', `/api/campaigns/cmp-1/run${query}`), params);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ success: false, error: 'This campaign is stopped. Restart it before running it.' });
    expect(getGlobalSettings).not.toHaveBeenCalled();
    expect(fake.campaignEnrollment.findMany).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
  });
});

describe('restarting a stopped campaign', () => {
  beforeEach(() => {
    campaign = { ...campaign, status: 'Stopped', stoppedAt: STOPPED_AT };
  });

  it('makes it Active again, clearing the stop time, and leaves every enrollment where it was', async () => {
    const res = await change({ status: 'Active' });

    expect(res.status).toBe(200);
    expect(mockedDb.updateCampaign).toHaveBeenCalledWith('cmp-1', { status: 'Active', pausedUntil: null, pauseReason: null, stoppedAt: null });
    expect(campaign).toMatchObject({ status: 'Active', stoppedAt: null });
    expect(writes()).toEqual([]);
  });

  it('runs the checks publishing runs: complete steps and a sending schedule', async () => {
    campaign.steps = [{ subject: 'Hi', body: '' }];
    const incomplete = await change({ status: 'Active' });
    expect(incomplete.status).toBe(400);
    expect((await incomplete.json()).error).toBe('Step 1 has no body. Complete every step before activating this campaign.');

    campaign.steps = COMPLETE_STEPS;
    campaign.sendSchedule = null;
    const unscheduled = await change({ status: 'Active' });
    expect(unscheduled.status).toBe(400);
    expect((await unscheduled.json()).error).toBe(SCHEDULE_REQUIRED_ERROR);

    expect(mockedDb.updateCampaign).not.toHaveBeenCalled();
    expect(campaign).toMatchObject({ status: 'Stopped', stoppedAt: STOPPED_AT });
  });

  it('can be stopped again once running', async () => {
    expect((await change({ status: 'Active' })).status).toBe(200);
    expect((await change({ status: 'Stopped' })).status).toBe(200);
    expect(campaign.status).toBe('Stopped');
    expect(campaign.stoppedAt).toBeInstanceOf(Date);
  });
});

describe('other status changes leave stoppedAt alone', () => {
  it('writes no stoppedAt when pausing or activating a campaign that was never stopped', async () => {
    expect((await change({ status: 'Paused' })).status).toBe(200);
    expect(mockedDb.updateCampaign).toHaveBeenLastCalledWith('cmp-1', { status: 'Paused', pausedUntil: null, pauseReason: 'user' });

    expect((await change({ status: 'Active' })).status).toBe(200);
    expect(mockedDb.updateCampaign).toHaveBeenLastCalledWith('cmp-1', { status: 'Active', pausedUntil: null, pauseReason: null });
  });
});

describe('lib/campaignStop', () => {
  it('lets a stopped campaign take only a restart, and stops only Active or Paused ones', () => {
    expect(stopChangeError('Stopped', { status: 'Active' })).toBeNull();
    expect(stopChangeError('Stopped', { status: 'Active', name: 'x' })).toBe(CAMPAIGN_STOPPED_ERROR);
    expect(stopChangeError('Stopped', {})).toBe(CAMPAIGN_STOPPED_ERROR);
    expect(stopChangeError('Active', { status: 'Stopped' })).toBeNull();
    expect(stopChangeError('Paused', { status: 'Stopped' })).toBeNull();
    expect(stopChangeError('Draft', { status: 'Stopped' })).toBe(NOT_STOPPABLE_ERROR);
    expect(stopChangeError('Draft', { status: 'Active', name: 'x' })).toBeNull();
  });

  it('writes stoppedAt only when a change stops or restarts the campaign', () => {
    const now = new Date('2026-09-30T12:00:00.000Z');
    expect(stoppedAtChange('Active', 'Stopped', now)).toBe(now);
    expect(stoppedAtChange('Stopped', 'Active', now)).toBeNull();
    expect(stoppedAtChange('Stopped', 'Stopped', now)).toBeUndefined();
    expect(stoppedAtChange('Active', 'Paused', now)).toBeUndefined();
    expect(stoppedAtChange('Paused', undefined, now)).toBeUndefined();
  });

  it('asks before stopping, saying how many leads keep their place, and before restarting', () => {
    expect(stopConfirmMessage('Launch', 3)).toMatch(/^Stop "Launch"\? It sends nothing more until you restart it/);
    expect(stopConfirmMessage('Launch', 3)).toContain('Its 3 leads still in the sequence keep their place, so a restart continues each from the step it was on.');
    expect(stopConfirmMessage('Launch', 1)).toContain('Its 1 lead still in the sequence keeps its place, so a restart continues it');
    expect(stopConfirmMessage('Launch', 0)).toContain('No lead is still in its sequence.');
    expect(stopConfirmMessage('Launch', 0)).toMatch(/An email already being sent when you stop still goes out\.$/);
    expect(restartConfirmMessage('Launch')).toMatch(/^Restart "Launch"\? It becomes Active and sends its saved steps again inside its sending window\./);
  });

  it('says when a stopped campaign was stopped', () => {
    expect(isStopped({ status: 'Stopped' })).toBe(true);
    expect(isStopped({ status: 'Paused' })).toBe(false);
    expect(isStopped(null)).toBe(false);
    expect(stoppedNote({ status: 'Stopped', stoppedAt: STOPPED_AT.toISOString() })).toMatch(/^Stopped on .*2026, \d\d:\d\d$/);
    expect(stoppedNote({ status: 'Stopped', stoppedAt: null })).toBe('Stopped');
    expect(stoppedNote({ status: 'Stopped', stoppedAt: 'not a date' })).toBe('Stopped');
    expect(stoppedNote({ status: 'Paused', stoppedAt: STOPPED_AT })).toBeNull();
  });
});
