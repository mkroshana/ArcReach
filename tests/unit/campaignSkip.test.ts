import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * In-memory campaigns, leads, enrollments and dispatches. The fake models
 * evaluate the where clauses lib/campaignSkip and the campaign routes build
 * (helpers/prismaWhere), so the tests check which leads really end up Skipped.
 */
const fake = vi.hoisted(() => ({
  campaign: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
  campaignEnrollment: { count: vi.fn(), updateMany: vi.fn(), createMany: vi.fn() },
  lead: { findMany: vi.fn() },
  suppressedEmail: { findMany: vi.fn() },
  $transaction: vi.fn(),
}));

vi.mock('../../lib/db', () => ({
  db: { updateCampaign: vi.fn(), deleteCampaign: vi.fn() },
  prisma: fake,
}));

vi.mock('../../lib/session', () => ({
  getSession: vi.fn(),
}));

import { db } from '../../lib/db';
import { getSession } from '../../lib/session';
import { PUT as putCampaigns, DELETE as deleteCampaign } from '../../app/api/campaigns/route';
import { PUT as putCampaign } from '../../app/api/campaigns/[id]/route';
import { cohortLeadWhere, enrollGroupJoiners } from '../../lib/campaignCohort';
import {
  MAX_SKIP_CAMPAIGNS,
  parseSkipCampaignIds,
  restoreSkippedLeads,
  skipCampaignsError,
  skipEmailedLeads,
  skipSources,
  skippingCampaignsError,
  storedSkipCampaignIds,
} from '../../lib/campaignSkip';
import { leadProgressRows, skippedByText, skippedLeadsNote } from '../../lib/campaignProgress';
import { sequenceCounts } from '../../lib/campaignListPanel';
import { type Relations, matchesWhere } from './helpers/prismaWhere';

const mockedDb = db as any;
const mockedSession = vi.mocked(getSession);

const USER = { id: 'user-1', name: 'User', email: 'user@example.com', role: 'USER' as const };
const ADMIN = { id: 'admin-1', name: 'Admin', email: 'admin@example.com', role: 'ADMIN' as const };

type CampaignRow = {
  id: string; name: string; userId: string; status: string; audienceCohort: string; skipLeadsEmailedBy: string[];
  updatedAt: Date; cohortSyncRequestedAt: Date | null; senderAccountId: string; timezone: string; sendSchedule: unknown;
  user: { disabledAt: Date | null }; steps: { subject: string; body: string }[];
};
type LeadRow = { id: string; email: string; status: string; validationStatus: string; isArchived: boolean; groupIds: string[] };
type EnrollmentRow = { id: string; campaignId: string; leadId: string; status: string; currentSequenceStep: number; nextActionDate: Date | null };
type DispatchRow = { leadId: string; campaignId: string | null; stepOrder: number | null; status: string };

let campaigns: CampaignRow[];
let leads: LeadRow[];
let enrollments: EnrollmentRow[];
let dispatches: DispatchRow[];

const UPDATED_AT = new Date('2026-10-14T08:00:00.000Z');
/** When the Job Board leads were enrolled, so due since. */
const DUE = new Date('2026-10-14T07:00:00.000Z');
const ANY_TIME = { days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], window: { start: '00:00', end: '23:59' } };

const relations: Relations = {
  lead: (row) => leads.find((l) => l.id === row.leadId),
  dispatches: (row) => dispatches.filter((d) => d.leadId === row.id),
  groups: (row) => row.groupIds.map((groupId: string) => ({ groupId })),
};

const campaignRow = (id: string) => campaigns.find((c) => c.id === id)!;
const jobBoard = (leadId: string) => enrollments.find((e) => e.campaignId === 'jobboard' && e.leadId === leadId)!;
const statuses = (campaignId = 'jobboard') =>
  Object.fromEntries(enrollments.filter((e) => e.campaignId === campaignId).map((e) => [e.leadId, e.status]));

function addCampaign(id: string, name: string, userId: string, over: Partial<CampaignRow> = {}) {
  campaigns.push({
    id, name, userId, status: 'Draft', audienceCohort: 'g-job', skipLeadsEmailedBy: [], updatedAt: UPDATED_AT,
    cohortSyncRequestedAt: null, senderAccountId: 'mb-1', timezone: 'UTC', sendSchedule: ANY_TIME,
    user: { disabledAt: null }, steps: [{ subject: 'Hello', body: 'Hi there' }], ...over,
  });
}

/** A lead in the Job Board group, enrolled in the Job Board campaign at step 1. */
function addLead(id: string, emailedBy: Array<Partial<DispatchRow>> = []) {
  leads.push({ id, email: `${id}@prospect.test`, status: 'Neutral', validationStatus: 'Valid', isArchived: false, groupIds: ['g-job'] });
  enrollments.push({ id: `job-${id}`, campaignId: 'jobboard', leadId: id, status: 'Active', currentSequenceStep: 1, nextActionDate: DUE });
  for (const dispatch of emailedBy) {
    dispatches.push({ leadId: id, campaignId: 'winback', stepOrder: 1, status: 'Sent', ...dispatch });
  }
}

function makeReq(method: string, path: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  campaigns = [];
  leads = [];
  enrollments = [];
  dispatches = [];
  addCampaign('winback', 'Win-Back Emails', 'user-1', { status: 'Active', audienceCohort: 'g-winback' });
  addCampaign('jobboard', 'Google Job Board Emails', 'user-1');
  addCampaign('theirs', 'Another Owner', 'user-2', { audienceCohort: 'g-theirs' });

  // Win-Back sent ann its step 1, has eve's in flight and never confirmed fay's.
  addLead('ann', [{}]);
  addLead('eve', [{ status: 'Sending' }]);
  addLead('fay', [{ status: 'Unknown' }]);
  // It only failed to send to bob, and only replied to cat by hand in Unibox.
  addLead('bob', [{ status: 'Failed' }]);
  addLead('cat', [{ stepOrder: null }]);
  // It never emailed dan, and gus got an email from another owner's campaign.
  addLead('dan');
  addLead('gus', [{ campaignId: 'theirs' }]);
  // ann is still in the Win-Back sequence too.
  enrollments.push({ id: 'win-ann', campaignId: 'winback', leadId: 'ann', status: 'Active', currentSequenceStep: 3, nextActionDate: DUE });

  mockedSession.mockResolvedValue(USER);
  fake.campaign.findMany.mockImplementation(async ({ where, orderBy }: any) => {
    const rows = campaigns.filter((c) => matchesWhere(c, where));
    return orderBy?.name ? rows.sort((a, b) => a.name.localeCompare(b.name)) : rows;
  });
  fake.campaign.findUnique.mockImplementation(async ({ where }: any) => campaigns.find((c) => c.id === where.id) ?? null);
  fake.campaign.findFirst.mockImplementation(async ({ where }: any) => campaigns.find((c) => matchesWhere(c, where)) ?? null);
  fake.campaign.updateMany.mockImplementation(async ({ where, data }: any) => {
    const hit = campaigns.filter((c) => matchesWhere(c, where));
    hit.forEach((c) => Object.assign(c, data));
    return { count: hit.length };
  });
  fake.campaignEnrollment.count.mockImplementation(async ({ where }: any) =>
    enrollments.filter((e) => matchesWhere(e, where, relations)).length);
  fake.campaignEnrollment.updateMany.mockImplementation(async ({ where, data }: any) => {
    const hit = enrollments.filter((e) => matchesWhere(e, where, relations));
    hit.forEach((e) => Object.assign(e, data));
    return { count: hit.length };
  });
  fake.campaignEnrollment.createMany.mockImplementation(async ({ data }: any) => {
    const fresh = data.filter((row: any) => !enrollments.some((e) => e.campaignId === row.campaignId && e.leadId === row.leadId));
    fresh.forEach((row: any) => enrollments.push({ id: `${row.campaignId}-${row.leadId}`, ...row }));
    return { count: fresh.length };
  });
  fake.lead.findMany.mockImplementation(async ({ where }: any) =>
    leads.filter((l) => matchesWhere(l, where, relations)).map(({ id, email }) => ({ id, email })));
  fake.suppressedEmail.findMany.mockResolvedValue([]);
  fake.$transaction.mockImplementation(async (fn: any) => fn(fake));
  mockedDb.updateCampaign.mockImplementation(async (id: string, updates: any) => Object.assign(campaignRow(id), updates));
  mockedDb.deleteCampaign.mockImplementation(async (id: string) => {
    campaigns = campaigns.filter((c) => c.id !== id);
  });
});

describe('skipEmailedLeads', () => {
  it('marks Skipped the leads a named campaign sent a sequence email, has one in flight for or never confirmed one to', async () => {
    expect(await skipEmailedLeads(fake as any, 'jobboard', ['winback'])).toBe(3);
    expect(statuses()).toEqual({
      ann: 'Skipped', eve: 'Skipped', fay: 'Skipped',
      // A failed attempt sent nothing, a Unibox reply is no sequence email, and the others got nothing from Win-Back.
      bob: 'Active', cat: 'Active', dan: 'Active', gus: 'Active',
    });
  });

  it('keeps the step and send date of a lead it skips, and leaves the named campaign sending to it', async () => {
    await skipEmailedLeads(fake as any, 'jobboard', ['winback']);
    expect(jobBoard('ann')).toMatchObject({ status: 'Skipped', currentSequenceStep: 1, nextActionDate: DUE });
    expect(statuses('winback')).toEqual({ ann: 'Active' });
  });

  it('counts the emails of every campaign the list names', async () => {
    expect(await skipEmailedLeads(fake as any, 'jobboard', ['winback', 'theirs'])).toBe(4);
    expect(jobBoard('gus').status).toBe('Skipped');
  });

  it('marks only the leads asked about, when given', async () => {
    expect(await skipEmailedLeads(fake as any, 'jobboard', ['winback'], ['ann', 'dan'])).toBe(1);
    expect(statuses()).toMatchObject({ ann: 'Skipped', eve: 'Active', fay: 'Active', dan: 'Active' });
    expect(await skipEmailedLeads(fake as any, 'jobboard', ['winback'], [])).toBe(0);
  });

  it('leaves alone a lead that is no longer in the sequence', async () => {
    jobBoard('ann').status = 'Paused';
    jobBoard('eve').status = 'Completed';
    expect(await skipEmailedLeads(fake as any, 'jobboard', ['winback'])).toBe(1);
    expect(statuses()).toMatchObject({ ann: 'Paused', eve: 'Completed', fay: 'Skipped' });
  });

  it('asks the database nothing for a campaign that skips no campaign\'s leads', async () => {
    expect(await skipEmailedLeads(fake as any, 'jobboard', [])).toBe(0);
    expect(fake.campaignEnrollment.updateMany).not.toHaveBeenCalled();
  });
});

describe('restoreSkippedLeads', () => {
  const audience = () => cohortLeadWhere('g-job');
  const NOW = new Date('2026-10-14T09:00:00.000Z');

  beforeEach(async () => {
    await skipEmailedLeads(fake as any, 'jobboard', ['winback', 'theirs']);
  });

  it('changes nothing while the list still names the campaign that emailed each lead', async () => {
    expect(await restoreSkippedLeads(fake as any, 'jobboard', ['winback', 'theirs'], audience(), NOW)).toBe(0);
    expect(statuses()).toMatchObject({ ann: 'Skipped', eve: 'Skipped', fay: 'Skipped', gus: 'Skipped' });
  });

  it('puts back the leads skipped only for a campaign taken out of the list, where they were', async () => {
    jobBoard('gus').currentSequenceStep = 2;
    const later = new Date('2026-10-16T07:00:00.000Z');
    jobBoard('gus').nextActionDate = later;

    expect(await restoreSkippedLeads(fake as any, 'jobboard', ['winback'], audience(), NOW)).toBe(1);

    // Still waiting out its step's days, not sent early.
    expect(jobBoard('gus')).toMatchObject({ status: 'Active', currentSequenceStep: 2, nextActionDate: later });
    expect(statuses()).toMatchObject({ ann: 'Skipped', eve: 'Skipped', fay: 'Skipped' });
  });

  it('puts every skipped lead back once the list is empty, due as it was', async () => {
    expect(await restoreSkippedLeads(fake as any, 'jobboard', [], audience(), NOW)).toBe(4);
    expect(statuses()).toEqual({ ann: 'Active', eve: 'Active', fay: 'Active', bob: 'Active', cat: 'Active', dan: 'Active', gus: 'Active' });
    expect(jobBoard('ann').nextActionDate).toEqual(DUE);
  });

  it('gives a send date to a lead put back without one, so it is not left Active and never due', async () => {
    jobBoard('ann').nextActionDate = null;
    await restoreSkippedLeads(fake as any, 'jobboard', [], audience(), NOW);
    expect(jobBoard('ann')).toMatchObject({ status: 'Active', nextActionDate: NOW });
  });

  it('pauses, and does not put back, a lead that left the audience while it was skipped', async () => {
    leads.find((l) => l.id === 'ann')!.groupIds = [];
    leads.find((l) => l.id === 'eve')!.isArchived = true;

    expect(await restoreSkippedLeads(fake as any, 'jobboard', [], audience(), NOW)).toBe(2);

    expect(statuses()).toMatchObject({ ann: 'Paused', eve: 'Paused', fay: 'Active', gus: 'Active' });
  });

  it('leaves a lead that left the audience Skipped while a named campaign still covers it', async () => {
    leads.find((l) => l.id === 'ann')!.groupIds = [];
    await restoreSkippedLeads(fake as any, 'jobboard', ['winback'], audience(), NOW);
    expect(jobBoard('ann').status).toBe('Skipped');
  });
});

describe('skipSources', () => {
  it('names each campaign of the list with how many of the skipped leads it emailed', async () => {
    // Win-Back emailed gus as well, so gus counts under both campaigns.
    dispatches.push({ leadId: 'gus', campaignId: 'winback', stepOrder: 2, status: 'Sent' });
    await skipEmailedLeads(fake as any, 'jobboard', ['winback', 'theirs']);

    expect(await skipSources(fake as any, 'jobboard', ['winback', 'theirs', 'gone'])).toEqual([
      { id: 'winback', name: 'Win-Back Emails', leads: 4 },
      { id: 'theirs', name: 'Another Owner', leads: 1 },
      { id: 'gone', name: null, leads: 0 },
    ]);
  });

  it('counts only leads the campaign skips, not every lead the other campaign emailed', async () => {
    // Nothing is marked yet: Win-Back has emailed three of the leads, and none is skipped.
    expect(await skipSources(fake as any, 'jobboard', ['winback'])).toEqual([{ id: 'winback', name: 'Win-Back Emails', leads: 0 }]);
  });

  it('asks the database nothing for an empty list', async () => {
    expect(await skipSources(fake as any, 'jobboard', [])).toEqual([]);
    expect(fake.campaign.findMany).not.toHaveBeenCalled();
    expect(fake.campaignEnrollment.count).not.toHaveBeenCalled();
  });
});

describe('the list a save sends', () => {
  it('is read as campaign IDs, once each, in the order given', () => {
    expect(parseSkipCampaignIds(['winback', 'theirs', 'winback'], 'jobboard')).toEqual({ ids: ['winback', 'theirs'], error: null });
    expect(parseSkipCampaignIds([], 'jobboard')).toEqual({ ids: [], error: null });
  });

  it('is refused when it is not a list of IDs, names the campaign itself or is too long', () => {
    expect(parseSkipCampaignIds('winback', 'jobboard').error).toBe('skipLeadsEmailedBy must be a list of campaign IDs.');
    expect(parseSkipCampaignIds(['winback', 7], 'jobboard').error).toBe('skipLeadsEmailedBy must be a list of campaign IDs.');
    expect(parseSkipCampaignIds(['winback', ' '], 'jobboard').error).toBe('skipLeadsEmailedBy must be a list of campaign IDs.');
    expect(parseSkipCampaignIds(['winback', 'jobboard'], 'jobboard').error)
      .toBe('A campaign cannot skip the leads it emailed itself. Take it out of Skip Leads Emailed By.');
    const many = Array.from({ length: MAX_SKIP_CAMPAIGNS + 1 }, (_, i) => `cmp-${i}`);
    expect(parseSkipCampaignIds(many, 'jobboard').error).toBe(`Skip Leads Emailed By takes at most ${MAX_SKIP_CAMPAIGNS} campaigns.`);
    expect(parseSkipCampaignIds(many.slice(1), 'jobboard').error).toBeNull();
  });

  it('reads a row loaded without the column as an empty list', () => {
    expect(storedSkipCampaignIds(undefined)).toEqual([]);
    expect(storedSkipCampaignIds(['winback'])).toEqual(['winback']);
  });

  it('may name only campaigns that exist and that the session may see', async () => {
    const refusal = 'Skip Leads Emailed By names a campaign that does not exist or is not yours.';
    expect(await skipCampaignsError(fake as any, USER, ['winback'])).toBeNull();
    expect(await skipCampaignsError(fake as any, USER, ['winback', 'theirs'])).toBe(refusal);
    expect(await skipCampaignsError(fake as any, USER, ['gone'])).toBe(refusal);
    expect(await skipCampaignsError(fake as any, ADMIN, ['winback', 'theirs'])).toBeNull();
    expect(await skipCampaignsError(fake as any, USER, [])).toBeNull();
  });
});

describe('PUT /api/campaigns/[id] Skip Leads Emailed By', () => {
  const save = (body: Record<string, unknown>) =>
    putCampaign(makeReq('PUT', '/api/campaigns/jobboard', { updatedAt: campaignRow('jobboard').updatedAt.toISOString(), ...body }), {
      params: Promise.resolve({ id: 'jobboard' }),
    });

  it('stores the list and marks the leads its campaigns have emailed', async () => {
    const res = await save({ skipLeadsEmailedBy: ['winback'] });
    expect(res.status).toBe(200);
    expect(campaignRow('jobboard').skipLeadsEmailedBy).toEqual(['winback']);
    expect(statuses()).toEqual({ ann: 'Skipped', eve: 'Skipped', fay: 'Skipped', bob: 'Active', cat: 'Active', dan: 'Active', gus: 'Active' });
  });

  it('puts the leads back when the campaign is taken out of the list', async () => {
    await save({ skipLeadsEmailedBy: ['winback'] });
    const res = await save({ skipLeadsEmailedBy: [] });
    expect(res.status).toBe(200);
    expect(campaignRow('jobboard').skipLeadsEmailedBy).toEqual([]);
    expect(Object.values(statuses())).toEqual(Array(7).fill('Active'));
  });

  it('marks the leads emailed since the last save when a save keeps the stored list, sent or not', async () => {
    await save({ skipLeadsEmailedBy: ['winback'] });
    dispatches.push({ leadId: 'dan', campaignId: 'winback', stepOrder: 1, status: 'Sent' });

    expect((await save({ name: 'Renamed' })).status).toBe(200);
    expect(jobBoard('dan').status).toBe('Skipped');
    expect(campaignRow('jobboard').skipLeadsEmailedBy).toEqual(['winback']);
  });

  it('touches no enrollment for a campaign that never had a list and is saved without one', async () => {
    expect((await save({ name: 'Renamed' })).status).toBe(200);
    expect(fake.campaignEnrollment.updateMany).not.toHaveBeenCalled();
  });

  it('refuses a list that names the campaign itself, another owner\'s campaign or none that exists, and saves nothing', async () => {
    for (const [list, error] of [
      [['jobboard'], 'A campaign cannot skip the leads it emailed itself. Take it out of Skip Leads Emailed By.'],
      [['theirs'], 'Skip Leads Emailed By names a campaign that does not exist or is not yours.'],
      [['gone'], 'Skip Leads Emailed By names a campaign that does not exist or is not yours.'],
      ['winback', 'skipLeadsEmailedBy must be a list of campaign IDs.'],
    ] as const) {
      const res = await save({ skipLeadsEmailedBy: list });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe(error);
    }
    expect(fake.$transaction).not.toHaveBeenCalled();
    expect(campaignRow('jobboard').skipLeadsEmailedBy).toEqual([]);
  });

  it("keeps a campaign an admin named when the owner saves the list again, though the owner could not add it", async () => {
    campaignRow('jobboard').skipLeadsEmailedBy = ['theirs'];
    const res = await save({ skipLeadsEmailedBy: ['theirs', 'winback'] });
    expect(res.status).toBe(200);
    expect(campaignRow('jobboard').skipLeadsEmailedBy).toEqual(['theirs', 'winback']);
    expect(statuses()).toMatchObject({ ann: 'Skipped', gus: 'Skipped', dan: 'Active' });
  });

  it('says the campaign was saved when marking the leads fails, so the next save finishes it', async () => {
    fake.campaignEnrollment.updateMany.mockRejectedValueOnce(new Error('connection lost'));
    const res = await save({ skipLeadsEmailedBy: ['winback'] });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: 'The campaign was saved, but working out which leads to skip did not finish (connection lost). Save again to finish it.',
      saved: true,
    });
    expect(campaignRow('jobboard').skipLeadsEmailedBy).toEqual(['winback']);

    expect((await save({ skipLeadsEmailedBy: ['winback'] })).status).toBe(200);
    expect(statuses()).toMatchObject({ ann: 'Skipped', eve: 'Skipped', fay: 'Skipped' });
  });
});

describe('PUT /api/campaigns status', () => {
  const setStatus = (status: string) => putCampaigns(makeReq('PUT', '/api/campaigns', { id: 'jobboard', status }));

  it('marks the leads to skip when the campaign is made Active, before the send engine reaches them', async () => {
    campaignRow('jobboard').skipLeadsEmailedBy = ['winback'];
    expect((await setStatus('Active')).status).toBe(200);
    expect(campaignRow('jobboard').status).toBe('Active');
    expect(statuses()).toMatchObject({ ann: 'Skipped', eve: 'Skipped', fay: 'Skipped', dan: 'Active' });
  });

  it('marks nothing for another status, or for a campaign that skips no campaign\'s leads', async () => {
    expect((await setStatus('Active')).status).toBe(200);
    campaignRow('jobboard').skipLeadsEmailedBy = ['winback'];
    expect((await setStatus('Paused')).status).toBe(200);
    expect(fake.campaignEnrollment.updateMany).not.toHaveBeenCalled();
  });

  it('still makes the campaign Active when marking the leads fails: the send engine checks each one again', async () => {
    campaignRow('jobboard').skipLeadsEmailedBy = ['winback'];
    fake.campaignEnrollment.updateMany.mockRejectedValueOnce(new Error('connection lost'));
    expect((await setStatus('Active')).status).toBe(200);
    expect(campaignRow('jobboard').status).toBe('Active');
  });
});

describe('DELETE /api/campaigns', () => {
  const remove = (id: string) => deleteCampaign(makeReq('DELETE', `/api/campaigns?id=${id}`));

  it('refuses to delete a campaign another one skips the leads of, naming it', async () => {
    campaignRow('jobboard').skipLeadsEmailedBy = ['winback'];
    const res = await remove('winback');
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(
      'This campaign can\'t be deleted: "Google Job Board Emails" skips the leads it emailed. Take it out of Skip Leads Emailed By on the Audience tab of that campaign first.',
    );
    expect(mockedDb.deleteCampaign).not.toHaveBeenCalled();
  });

  it('deletes it once no campaign names it, and deletes a campaign that only does the skipping', async () => {
    campaignRow('jobboard').skipLeadsEmailedBy = ['winback'];
    expect((await remove('jobboard')).status).toBe(200);
    expect((await remove('winback')).status).toBe(200);
    expect(campaigns.map((c) => c.id)).toEqual(['theirs']);
  });

  it('names only the campaigns the session may see', async () => {
    campaignRow('jobboard').skipLeadsEmailedBy = ['winback'];
    campaignRow('theirs').skipLeadsEmailedBy = ['winback'];
    expect(await skippingCampaignsError(fake as any, USER, 'winback')).toBe(
      'This campaign can\'t be deleted: "Google Job Board Emails" and 1 more skip the leads it emailed. Take it out of Skip Leads Emailed By on the Audience tab of those campaigns first.',
    );
    expect(await skippingCampaignsError(fake as any, ADMIN, 'winback')).toBe(
      'This campaign can\'t be deleted: "Another Owner" and "Google Job Board Emails" skip the leads it emailed. Take it out of Skip Leads Emailed By on the Audience tab of those campaigns first.',
    );
    expect(await skippingCampaignsError(fake as any, { id: 'user-3', role: 'USER' }, 'winback')).toBe(
      "This campaign can't be deleted: 2 other campaigns skip the leads it emailed. Take it out of Skip Leads Emailed By on the Audience tab of those campaigns first.",
    );
    expect(await skippingCampaignsError(fake as any, USER, 'jobboard')).toBeNull();
  });
});

describe('enrollGroupJoiners', () => {
  it('marks a lead that joins the audience group Skipped at once when a named campaign has emailed it', async () => {
    campaignRow('jobboard').skipLeadsEmailedBy = ['winback'];
    for (const id of ['hal', 'ida']) {
      leads.push({ id, email: `${id}@prospect.test`, status: 'Neutral', validationStatus: 'Valid', isArchived: false, groupIds: ['g-job'] });
    }
    dispatches.push({ leadId: 'hal', campaignId: 'winback', stepOrder: 1, status: 'Sent' });

    await enrollGroupJoiners(fake as any, ['hal', 'ida'], ['g-job']);

    expect(statuses()).toMatchObject({ hal: 'Skipped', ida: 'Active' });
    // Only the joiners are looked at: ann was enrolled before and is marked by a save or the send engine.
    expect(jobBoard('ann').status).toBe('Active');
  });
});

describe('what the pages say about skipped leads', () => {
  const WINBACK = 'Win-Back Emails';

  it('names up to two campaigns in the campaigns list line, and counts more', () => {
    expect(skippedByText([WINBACK])).toBe(WINBACK);
    expect(skippedByText([WINBACK, 'Trial Ended'])).toBe('Win-Back Emails and Trial Ended');
    expect(skippedByText([WINBACK, 'Trial Ended', 'Spring'])).toBe('3 other campaigns');
    expect(skippedByText([WINBACK, 'Trial Ended', 'Spring'], Infinity)).toBe('Win-Back Emails, Trial Ended and Spring');
  });

  it('does not guess a campaign whose name the viewer does not have', () => {
    expect(skippedByText([null])).toBe('another campaign');
    expect(skippedByText([WINBACK, null])).toBe('2 other campaigns');
    expect(skippedByText([])).toBe('another campaign');
  });

  it('adds the skipped leads to the line under a campaign in the list, only when there are any', () => {
    const stepStats = [{ stepOrder: 1, active: 538, sent: 0 }];
    expect(sequenceCounts(stepStats, { completed: 0, skipped: 212 }, [WINBACK]))
      .toBe('538 leads in sequence · 0 completed · 212 skipped, already emailed by Win-Back Emails');
    expect(sequenceCounts(stepStats, { completed: 0, notMailable: 3, skipped: 1 }, [null]))
      .toBe('538 leads in sequence · 0 completed · 3 no longer mailable · 1 skipped, already emailed by another campaign');
    expect(sequenceCounts(stepStats, { completed: 0, skipped: 0 }, [WINBACK])).toBe('538 leads in sequence · 0 completed');
    expect(sequenceCounts(stepStats, { completed: 0 })).toBe('538 leads in sequence · 0 completed');
  });

  it('lists the skipped leads in Lead Progress after the leads still to get a step, saying which campaign emailed them', () => {
    const rows = leadProgressRows({ Active: 540, Skipped: 212, Completed: 1 }, 2, false, [WINBACK]);
    expect(rows.map((row) => [row.label, row.value])).toEqual([
      ['In Sequence', 538], ['No Longer Mailable', 2], ['Skipped', 212],
      ['Completed', 1], ['Paused', 0], ['Bounced', 0], ['Failed', 0], ['Removed', 0],
    ]);
    expect(rows[2].description).toBe(
      'Already emailed by Win-Back Emails, whose leads this campaign is set to skip. They stay enrolled and get nothing from it.',
    );
  });

  it('shows the Skipped row at 0 for a campaign that skips a campaign\'s leads, and not at all for one that does not', () => {
    expect(leadProgressRows({ Active: 5 }, 0, false, [WINBACK]).map((row) => [row.label, row.value]).slice(0, 2))
      .toEqual([['In Sequence', 5], ['Skipped', 0]]);
    expect(leadProgressRows({ Active: 5 }, 0, false).map((row) => row.label)).not.toContain('Skipped');
    // Leads still Skipped after the list was emptied are never shown as an unknown status.
    expect(leadProgressRows({ Active: 5, Skipped: 1 }, 0, false).map((row) => [row.label, row.value]).slice(0, 2))
      .toEqual([['In Sequence', 5], ['Skipped', 1]]);
  });

  it('says under the setting how many leads are skipped and for which campaign', () => {
    expect(skippedLeadsNote({ total: 212, campaigns: [{ name: WINBACK, leads: 212 }] }, 750))
      .toBe("212 of this campaign's 750 leads are skipped: Win-Back Emails has already emailed them.");
    expect(skippedLeadsNote({ total: 1, campaigns: [{ name: WINBACK, leads: 1 }] }, 1))
      .toBe("1 of this campaign's 1 lead is skipped: Win-Back Emails has already emailed it.");
    expect(skippedLeadsNote({ total: 0, campaigns: [{ name: WINBACK, leads: 0 }] }, 750))
      .toBe('No lead of this campaign is skipped: Win-Back Emails has emailed none of them.');
    expect(skippedLeadsNote({ total: 0, campaigns: [] }, 750)).toBeNull();
    expect(skippedLeadsNote(undefined, 750)).toBeNull();
  });

  it('gives each campaign its own count when the list names several, and says when a lead counts twice', () => {
    expect(skippedLeadsNote({ total: 215, campaigns: [{ name: WINBACK, leads: 200 }, { name: 'Trial Ended', leads: 15 }] }, 750))
      .toBe("215 of this campaign's 750 leads are skipped, already emailed: 200 by Win-Back Emails and 15 by Trial Ended.");
    expect(skippedLeadsNote({ total: 210, campaigns: [{ name: WINBACK, leads: 200 }, { name: null, leads: 15 }] }, 750))
      .toBe("210 of this campaign's 750 leads are skipped, already emailed: 200 by Win-Back Emails and 15 by another campaign. A lead more than one of them emailed counts under each.");
  });
});
