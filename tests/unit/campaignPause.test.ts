import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * One in-memory campaign row. The fakes apply the where clauses the send
 * engine and both campaign PUT routes build, and move updatedAt on every write
 * as Prisma's @updatedAt does, so the tests follow what a quota pause, a user's
 * status change, a save and the auto-resume really leave behind.
 */
const fake = vi.hoisted(() => ({
  campaign: { findUnique: vi.fn(), updateMany: vi.fn() },
  campaignStep: { findMany: vi.fn(), update: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn() },
  campaignSenderAccount: { deleteMany: vi.fn(), createMany: vi.fn() },
  campaignEnrollment: { count: vi.fn(), update: vi.fn() },
  emailDispatch: { update: vi.fn() },
  $transaction: vi.fn(),
}));

vi.mock('../../lib/db', () => ({
  db: { getCampaigns: vi.fn(), updateCampaign: vi.fn() },
  prisma: fake,
}));

vi.mock('../../lib/session', () => ({
  getSession: vi.fn(),
}));

import { db } from '../../lib/db';
import { getSession } from '../../lib/session';
import { autoResumeQuotaPausedCampaigns, handleSendFailure } from '../../lib/sendEngine';
import { autoResumeNote, userStatusPause } from '../../lib/campaignPause';
import { CAMPAIGN_CHANGED_ERROR, nextCampaignVersion, parseCampaignVersion, sameCampaignVersion } from '../../lib/campaignVersion';
import { PUT as putCampaign } from '../../app/api/campaigns/[id]/route';
import { PUT as putCampaignList } from '../../app/api/campaigns/route';

const mockedDb = db as any;

const USER = { id: 'user-1', name: 'User', email: 'user@example.com', role: 'USER' as const };
const STEPS = [{ id: 'step-1', stepOrder: 1, waitDays: 0, subject: 'Hi', body: 'Hello there' }];
const HOUR_MS = 60 * 60 * 1000;

type CampaignRow = {
  id: string; userId: string; name: string; status: string; audienceCohort: string;
  pausedUntil: Date | null; pauseReason: string | null; timezone: string; updatedAt: Date;
};

let campaign: CampaignRow;
let enrollment: { id: string; nextActionDate: Date | null; claimToken: string | null; claimedAt: Date | null };

function matches(value: unknown, cond: unknown): boolean {
  if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
  if (cond === null || typeof cond !== 'object') return value === cond;
  if ('lte' in cond) return value instanceof Date && value <= (cond as { lte: Date }).lte;
  throw new Error(`Unmodelled filter: ${JSON.stringify(cond)}`);
}

function makeReq(path: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Writes `data` to the campaign row, moving updatedAt on unless `data` sets it, as Prisma does. */
function writeCampaign(data: Record<string, unknown>) {
  return Object.assign(campaign, { updatedAt: new Date(campaign.updatedAt.getTime() + 1000) }, data);
}

/**
 * The campaign page's Save (the form, never the status) or, with status Active,
 * Publish Sequence. Both name the version the page loaded, by default the stored one.
 */
const pageSave = (body: Record<string, unknown>, loadedVersion: Date = campaign.updatedAt) =>
  putCampaign(makeReq('/api/campaigns/cmp-1', { updatedAt: loadedVersion.toISOString(), ...body }), { params: Promise.resolve({ id: 'cmp-1' }) });

/** The status route: the campaign list's toggle, and the campaign page's status dropdown and Keep Paused. */
const listSave = (body: Record<string, unknown>) => putCampaignList(makeReq('/api/campaigns', { id: 'cmp-1', ...body }));

const sendError = (message: string) =>
  handleSendFailure({ id: 'enr-1', retryCount: 0, quotaFailures: 0 }, { id: 'lead-1', email: 'lead@prospect.test' }, null, new Error(message), 'Launch', 'cmp-1');

const QUOTA_ERROR = 'Email send quota exceeded for this resource.';
const CLOCK_SKEW_ERROR = 'The time difference between the originating client and the server is greater than the allowed margin of 5 minutes.';

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.mocked(getSession).mockResolvedValue(USER);

  campaign = {
    id: 'cmp-1', userId: 'user-1', name: 'Launch', status: 'Active', audienceCohort: 'Valid',
    pausedUntil: null, pauseReason: null, timezone: 'UTC', updatedAt: new Date('2026-09-01T10:00:00.000Z'),
  };
  enrollment = { id: 'enr-1', nextActionDate: null, claimToken: 'worker', claimedAt: new Date() };

  fake.campaign.findUnique.mockImplementation(async () => ({ ...campaign }));
  fake.campaign.updateMany.mockImplementation(async ({ where, data }: any) => {
    const hit = Object.entries(where).every(([key, cond]) => matches((campaign as any)[key], cond));
    if (hit) writeCampaign(data);
    return { count: hit ? 1 : 0 };
  });
  fake.campaignStep.findMany.mockResolvedValue(STEPS);
  fake.campaignEnrollment.count.mockResolvedValue(1);
  fake.campaignEnrollment.update.mockImplementation(async ({ data }: any) => Object.assign(enrollment, data));
  fake.$transaction.mockImplementation(async (arg: any) => (typeof arg === 'function' ? arg(fake) : Promise.all(arg)));
  mockedDb.getCampaigns.mockImplementation(async () => [{ ...campaign, steps: STEPS }]);
  mockedDb.updateCampaign.mockImplementation(async (_id: string, data: any) => ({ ...writeCampaign(data) }));
});

describe('the send engine pauses only an Active campaign (H8)', () => {
  it('pauses an Active campaign for an hour on a quota error and postpones the enrollment', async () => {
    const before = Date.now();

    expect(await sendError(QUOTA_ERROR)).toEqual({ action: 'break' });

    expect(campaign).toMatchObject({ status: 'Paused', pauseReason: 'quota' });
    const resumesIn = campaign.pausedUntil!.getTime() - before;
    expect(resumesIn).toBeGreaterThanOrEqual(HOUR_MS);
    expect(resumesIn).toBeLessThan(HOUR_MS + 5_000);
    expect(enrollment).toMatchObject({ nextActionDate: campaign.pausedUntil, claimToken: null, claimedAt: null });
  });

  it('records a clock-skew rejection as a systemic pause', async () => {
    await sendError(CLOCK_SKEW_ERROR);
    expect(campaign).toMatchObject({ status: 'Paused', pauseReason: 'systemic' });
  });

  it.each([
    ['Draft', null],
    ['Paused', 'user'],
  ])('leaves a %s campaign as the user set it, with no timer', async (status, pauseReason) => {
    Object.assign(campaign, { status, pauseReason });

    expect(await sendError(QUOTA_ERROR)).toEqual({ action: 'break' });

    expect(campaign).toMatchObject({ status, pausedUntil: null, pauseReason });
    expect(await autoResumeQuotaPausedCampaigns(new Date(Date.now() + 2 * HOUR_MS))).toBe(0);
    expect(campaign.status).toBe(status);
    // The enrollment still waits out the quota window.
    expect(enrollment.nextActionDate).toBeInstanceOf(Date);
  });
});

describe('a status the user sets cancels the auto-resume (H8)', () => {
  it('never re-activates a campaign the user paused after reactivating a quota pause', async () => {
    await sendError(QUOTA_ERROR);
    const later = new Date(campaign.pausedUntil!.getTime() + 3 * HOUR_MS);

    // The user reactivates early from the list, then pauses from the campaign page's dropdown to fix a link.
    expect((await listSave({ status: 'Active' })).status).toBe(200);
    expect(campaign).toMatchObject({ status: 'Active', pausedUntil: null, pauseReason: null });
    expect((await listSave({ status: 'Paused' })).status).toBe(200);
    expect(campaign).toMatchObject({ status: 'Paused', pausedUntil: null, pauseReason: 'user' });

    expect(await autoResumeQuotaPausedCampaigns(later)).toBe(0);
    expect(campaign.status).toBe('Paused');
  });

  it('clears the timer when the campaign page\'s dropdown moves an engine-paused campaign to Draft', async () => {
    await sendError(QUOTA_ERROR);

    expect((await listSave({ status: 'Draft' })).status).toBe(200);

    expect(campaign).toMatchObject({ status: 'Draft', pausedUntil: null, pauseReason: null });
    expect(await autoResumeQuotaPausedCampaigns(new Date(Date.now() + 2 * HOUR_MS))).toBe(0);
    expect(campaign.status).toBe('Draft');
  });

  it('keeps the timer when the campaign page saves an engine-paused campaign it loaded after the pause', async () => {
    await sendError(QUOTA_ERROR);
    const pausedUntil = campaign.pausedUntil;

    expect((await pageSave({ name: 'Launch v2', steps: STEPS })).status).toBe(200);

    expect(campaign).toMatchObject({ name: 'Launch v2', status: 'Paused', pausedUntil, pauseReason: 'quota' });
    expect(await autoResumeQuotaPausedCampaigns(new Date(pausedUntil!.getTime() + 1))).toBe(1);
    expect(campaign).toMatchObject({ status: 'Active', pausedUntil: null, pauseReason: null });
  });

  it('Keep Paused turns an engine pause into a user pause that never resumes', async () => {
    await sendError(QUOTA_ERROR);
    const later = new Date(campaign.pausedUntil!.getTime() + HOUR_MS);

    expect((await listSave({ status: 'Paused' })).status).toBe(200);

    expect(campaign).toMatchObject({ status: 'Paused', pausedUntil: null, pauseReason: 'user' });
    expect(await autoResumeQuotaPausedCampaigns(later)).toBe(0);
    expect(campaign.status).toBe('Paused');
  });

  it('refuses pausedUntil and pauseReason from the request body', async () => {
    for (const body of [{ pausedUntil: null }, { pauseReason: 'user' }, { status: 'Paused', pauseReason: 'quota' }]) {
      expect((await listSave(body)).status).toBe(400);
    }
    expect(mockedDb.updateCampaign).not.toHaveBeenCalled();
  });
});

describe('saving the campaign page never changes its status (H13)', () => {
  it('refuses a save from a page opened before an engine pause, so it never reactivates the campaign', async () => {
    const opened = campaign.updatedAt; // the page loaded the campaign while it was Active
    await sendError(QUOTA_ERROR);
    const pausedUntil = campaign.pausedUntil;

    // Save (the form only) and Publish Sequence (the form and Active) from the stale page
    for (const body of [{ name: 'Typo fixed', steps: STEPS }, { name: 'Typo fixed', steps: STEPS, status: 'Active' }]) {
      const res = await pageSave(body, opened);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: CAMPAIGN_CHANGED_ERROR, stale: true });
    }

    expect(campaign).toMatchObject({ name: 'Launch', status: 'Paused', pausedUntil, pauseReason: 'quota' });
    expect(fake.campaignStep.update).not.toHaveBeenCalled();
    expect(fake.campaignStep.createMany).not.toHaveBeenCalled();
  });

  it('moves the version on with every save, so a second tab on the old version is refused', async () => {
    const opened = campaign.updatedAt;

    const first = await pageSave({ name: 'Launch v2', steps: STEPS }, opened);
    expect(first.status).toBe(200);
    expect(campaign.updatedAt.getTime()).toBeGreaterThan(opened.getTime());
    expect(new Date((await first.json()).updatedAt).getTime()).toBe(campaign.updatedAt.getTime());

    const second = await pageSave({ name: 'Launch v3', steps: STEPS }, opened);
    expect(second.status).toBe(409);
    expect(campaign).toMatchObject({ name: 'Launch v2', status: 'Active' });
  });

  it('refuses a save when another write lands between its check and its write', async () => {
    // Another tab saves while this save checks its steps against the stored ones.
    fake.campaignStep.findMany.mockImplementationOnce(async () => {
      writeCampaign({ name: 'Other tab' });
      return STEPS;
    });

    const res = await pageSave({ name: 'This tab', steps: STEPS });

    expect(res.status).toBe(409);
    expect((await res.json()).stale).toBe(true);
    expect(campaign.name).toBe('Other tab');
    expect(fake.campaignStep.update).not.toHaveBeenCalled();
  });

  it('lets the page save after its own status change, reporting the version that change replaced', async () => {
    const opened = campaign.updatedAt;

    const res = await listSave({ status: 'Paused' });
    const changed = await res.json();

    // The page takes on the new version only when the change replaced the one it loaded.
    expect(sameCampaignVersion(changed.previousUpdatedAt, opened)).toBe(true);
    expect(sameCampaignVersion(changed.updatedAt, campaign.updatedAt)).toBe(true);
    expect((await pageSave({ name: 'Launch v2', steps: STEPS }, new Date(changed.updatedAt))).status).toBe(200);
    expect(campaign).toMatchObject({ name: 'Launch v2', status: 'Paused', pauseReason: 'user' });
  });

  it('requires the version the save edited', async () => {
    for (const updatedAt of [undefined, null, '', 'not a date', 1759312800000]) {
      const res = await putCampaign(makeReq('/api/campaigns/cmp-1', { name: 'Launch v2', updatedAt }), { params: Promise.resolve({ id: 'cmp-1' }) });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('updatedAt is required: send the updatedAt of the campaign you edited.');
    }
    expect(fake.$transaction).not.toHaveBeenCalled();
    expect(campaign.name).toBe('Launch');
  });

  it.each([['Running'], [''], [null], [1]])('rejects the status %j and saves nothing', async (status) => {
    const res = await pageSave({ status, steps: STEPS });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Field "status" must be one of Draft, Active, Paused.');
    expect(fake.$transaction).not.toHaveBeenCalled();
    expect(campaign.status).toBe('Active');
  });
});

describe('campaign versions (H13)', () => {
  it('reads a version only from a timestamp string', () => {
    expect(parseCampaignVersion('2026-09-01T10:00:00.000Z')?.getTime()).toBe(Date.UTC(2026, 8, 1, 10));
    for (const value of [undefined, null, '', '  ', 'not a date', 1759312800000, {}]) {
      expect(parseCampaignVersion(value)).toBeNull();
    }
  });

  it('compares Dates and the ISO strings the API sends to the millisecond', () => {
    const at = new Date('2026-09-01T10:00:00.123Z');
    expect(sameCampaignVersion(at, '2026-09-01T10:00:00.123Z')).toBe(true);
    expect(sameCampaignVersion(at, '2026-09-01T10:00:00.124Z')).toBe(false);
    expect(sameCampaignVersion(null, at)).toBe(false);
    expect(sameCampaignVersion('not a date', 'not a date')).toBe(false);
  });

  it('always writes a version later than the one it replaces', () => {
    const loaded = new Date('2026-09-01T10:00:00.000Z');
    expect(nextCampaignVersion(loaded, new Date('2026-09-02T00:00:00.000Z')).toISOString()).toBe('2026-09-02T00:00:00.000Z');
    expect(nextCampaignVersion(loaded, loaded).getTime()).toBe(loaded.getTime() + 1);
    // A server whose clock runs behind still moves the version on.
    expect(nextCampaignVersion(loaded, new Date('2026-08-31T00:00:00.000Z')).getTime()).toBe(loaded.getTime() + 1);
  });
});

describe('PUT /api/campaigns validates the timezone like PUT /api/campaigns/[id] (H8)', () => {
  it('rejects an unknown timezone and saves nothing', async () => {
    const res = await listSave({ timezone: 'Mars/Olympus_Mons' });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Field "timezone" must be a valid timezone such as America/New_York or UTC.');
    expect(mockedDb.updateCampaign).not.toHaveBeenCalled();
    expect(campaign.timezone).toBe('UTC');
  });

  it('saves a timezone the runtime knows', async () => {
    expect((await listSave({ timezone: 'America/New_York' })).status).toBe(200);
    expect(mockedDb.updateCampaign).toHaveBeenCalledWith('cmp-1', { timezone: 'America/New_York' });
  });
});

describe('autoResumeNote', () => {
  it('shows when an engine-paused campaign resumes, in 24-hour local time, with the reason', () => {
    const at = new Date(2026, 8, 29, 14, 5);
    expect(autoResumeNote({ status: 'Paused', pausedUntil: at, pauseReason: 'quota' }))
      .toMatch(/^Auto-resumes at 14.05 \(sending quota or rate limit reached\)$/);
    expect(autoResumeNote({ status: 'Paused', pausedUntil: at.toISOString(), pauseReason: 'systemic' }))
      .toMatch(/^Auto-resumes at 14.05 \(server clock out of sync with Azure, or no sender mailbox owned by the campaign owner\)$/);
    expect(autoResumeNote({ status: 'Paused', pausedUntil: at, pauseReason: 'config' }))
      .toMatch(/^Auto-resumes at 14.05 \(Azure settings or sender domain not accepted\)$/);
    // Pauses from before pauseReason existed carry no reason.
    expect(autoResumeNote({ status: 'Paused', pausedUntil: at, pauseReason: null })).toMatch(/^Auto-resumes at 14.05$/);
  });

  it('is empty for a campaign that will not resume on its own', () => {
    expect(autoResumeNote({ status: 'Paused', pausedUntil: null, pauseReason: 'user' })).toBeNull();
    expect(autoResumeNote({ status: 'Active', pausedUntil: new Date(), pauseReason: null })).toBeNull();
    expect(autoResumeNote({ status: 'Paused', pausedUntil: 'not a date', pauseReason: 'quota' })).toBeNull();
  });

  it('records a user pause and clears the reason for any other status', () => {
    expect(userStatusPause('Paused')).toEqual({ pausedUntil: null, pauseReason: 'user' });
    expect(userStatusPause('Active')).toEqual({ pausedUntil: null, pauseReason: null });
    expect(userStatusPause('Draft')).toEqual({ pausedUntil: null, pauseReason: null });
  });
});
