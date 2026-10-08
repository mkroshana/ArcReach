import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * In-memory leads, their campaign emails (with opens and clicks), replies,
 * groups and enrollments. The fake models evaluate the where clauses
 * lib/campaignLeadExport builds, so the tests check which leads each list
 * really holds and the rows adding one to a group leaves behind.
 */
const fake = vi.hoisted(() => ({
  campaign: { findUnique: vi.fn(), findMany: vi.fn() },
  lead: { findMany: vi.fn() },
  emailDispatch: { findMany: vi.fn(), groupBy: vi.fn() },
  inboundResponse: { findMany: vi.fn() },
  suppressedEmail: { findMany: vi.fn() },
  leadGroup: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
  leadGroupMembership: { findMany: vi.fn(), createMany: vi.fn() },
  campaignEnrollment: { createMany: vi.fn() },
  $transaction: vi.fn(),
}));

vi.mock('../../lib/db', () => ({ prisma: fake }));

vi.mock('../../lib/session', () => ({
  getSession: vi.fn(),
}));

import { getSession } from '../../lib/session';
import { GET, POST } from '../../app/api/campaigns/[id]/leads/route';
import { GROUP_ADD_BATCH, addLeadSetToGroup, campaignsByGroup, exportLeadSet, isLeadSet, leadSetCounts } from '../../lib/campaignLeadExport';
import { matchesWhere } from './helpers/prismaWhere';

type LeadRow = { id: string; email: string; name: string | null; company: string | null; jobTitle: string | null; status: string; validationStatus: string; isArchived: boolean };
type DispatchRow = {
  id: string; leadId: string; campaignId: string; stepOrder: number | null; status: string;
  deliveryStatus: string | null; bounceType: string | null; events: { eventType: string }[];
};
type ReplyRow = { leadId: string; campaignId: string | null; autoReply: string | null };

let leads: LeadRow[];
let dispatches: DispatchRow[];
let replies: ReplyRow[];
let suppressed: string[];
let groups: { id: string; name: string }[];
let memberships: { leadId: string; groupId: string }[];
let campaigns: { id: string; userId: string; audienceCohort: string }[];
let enrollments: { leadId: string; campaignId: string; status: string; currentSequenceStep: number }[];

const RELATIONS = {
  dispatches: (lead: LeadRow) => dispatches.filter((d) => d.leadId === lead.id),
  replies: (lead: LeadRow) => replies.filter((r) => r.leadId === lead.id),
  events: (dispatch: DispatchRow) => dispatch.events,
  groups: (lead: LeadRow) => memberships.filter((m) => m.leadId === lead.id),
};

function addLead(id: string, fields: Partial<LeadRow> = {}) {
  leads.push({ id, email: `${id}@example.com`, name: null, company: null, jobTitle: null, status: 'Neutral', validationStatus: 'Valid', isArchived: false, ...fields });
}

let nextDispatch = 0;
/** One of cmp-1's sequence emails to a lead: delivered unless said otherwise, with the events a person left on it. */
function email(leadId: string, fields: Partial<DispatchRow> = {}, ...eventTypes: string[]) {
  dispatches.push({
    id: `d${++nextDispatch}`, leadId, campaignId: 'cmp-1', stepOrder: 1, status: 'Sent', deliveryStatus: 'Delivered', bounceType: null,
    events: eventTypes.map((eventType) => ({ eventType })), ...fields,
  });
}

const reply = (leadId: string, fields: Partial<ReplyRow> = {}) => replies.push({ leadId, campaignId: 'cmp-1', autoReply: null, ...fields });

beforeEach(() => {
  vi.clearAllMocks();
  leads = [];
  dispatches = [];
  replies = [];
  suppressed = [];
  groups = [{ id: 'g-old', name: 'Old Group' }];
  memberships = [];
  campaigns = [{ id: 'cmp-1', userId: 'user-1', audienceCohort: 'Valid' }];
  enrollments = [];
  nextDispatch = 0;

  vi.mocked(getSession).mockResolvedValue({ id: 'user-1', name: 'User', email: 'user@example.com', role: 'USER' } as any);

  fake.lead.findMany.mockImplementation(async ({ where, select, orderBy }: any) => {
    const rows = leads.filter((lead) => matchesWhere(lead, where, RELATIONS));
    if (orderBy?.email) rows.sort((a, b) => a.email.localeCompare(b.email));
    return rows.map((row) => (select ? Object.fromEntries(Object.keys(select).map((key) => [key, (row as any)[key]])) : { ...row }));
  });
  fake.emailDispatch.findMany.mockImplementation(async ({ where, distinct }: any) => {
    const rows = dispatches.filter((d) => matchesWhere(d, where, RELATIONS));
    expect(distinct).toEqual(['leadId']);
    return [...new Set(rows.map((d) => d.leadId))].map((leadId) => ({ leadId }));
  });
  fake.emailDispatch.groupBy.mockImplementation(async ({ by, where }: any) => {
    expect(by).toEqual(['leadId']);
    const counts = new Map<string, number>();
    for (const d of dispatches.filter((row) => matchesWhere(row, where, RELATIONS))) counts.set(d.leadId, (counts.get(d.leadId) ?? 0) + 1);
    return [...counts].map(([leadId, count]) => ({ leadId, _count: { id: count } }));
  });
  fake.inboundResponse.findMany.mockImplementation(async ({ where }: any) =>
    [...new Set(replies.filter((r) => matchesWhere(r, where)).map((r) => r.leadId))].map((leadId) => ({ leadId })));
  fake.suppressedEmail.findMany.mockImplementation(async ({ where }: any) =>
    suppressed.filter((address) => where.email.in.includes(address)).map((address) => ({ email: address, reason: 'Unsubscribed' })));

  fake.campaign.findUnique.mockImplementation(async ({ where }: any) => campaigns.find((c) => c.id === where.id) ?? null);
  fake.campaign.findMany.mockImplementation(async ({ where }: any) => campaigns.filter((c) => matchesWhere(c, where)));
  fake.leadGroup.findUnique.mockImplementation(async ({ where }: any) => groups.find((g) => g.id === where.id) ?? null);
  fake.leadGroup.findFirst.mockImplementation(async ({ where }: any) => groups.find((g) => g.name === where.name) ?? null);
  fake.leadGroup.create.mockImplementation(async ({ data }: any) => {
    const group = { id: `g-${groups.length + 1}`, name: data.name };
    groups.push(group);
    return group;
  });
  fake.leadGroupMembership.findMany.mockImplementation(async ({ where }: any) => memberships.filter((m) => m.groupId === where.groupId).map(({ leadId }) => ({ leadId })));
  fake.leadGroupMembership.createMany.mockImplementation(async ({ data, skipDuplicates }: any) => {
    expect(skipDuplicates).toBe(true);
    const fresh = data.filter((row: any) => !memberships.some((m) => m.leadId === row.leadId && m.groupId === row.groupId));
    memberships.push(...fresh);
    return { count: fresh.length };
  });
  fake.campaignEnrollment.createMany.mockImplementation(async ({ data }: any) => {
    const fresh = data.filter((row: any) => !enrollments.some((e) => e.leadId === row.leadId && e.campaignId === row.campaignId));
    enrollments.push(...fresh.map(({ leadId, campaignId, status, currentSequenceStep }: any) => ({ leadId, campaignId, status, currentSequenceStep })));
    return { count: fresh.length };
  });
  fake.$transaction.mockImplementation(async (fn: (tx: typeof fake) => unknown) => fn(fake));
});

describe('the Delivered list', () => {
  it('holds each lead one of the campaign emails was delivered to, once, in address order', async () => {
    addLead('zoe');
    addLead('amy');
    addLead('never-sent');
    email('zoe');
    email('zoe', { stepOrder: 2 });
    email('amy');

    const rows = await exportLeadSet(fake as any, 'cmp-1', 'delivered');

    expect(rows.map((row) => [row.email, row.delivered])).toEqual([['amy@example.com', 1], ['zoe@example.com', 2]]);
  });

  it('leaves out a lead whose emails were not delivered: no report yet, bounced, filtered or only sent in another campaign', async () => {
    for (const id of ['no-report', 'soft', 'spam', 'failed-send', 'other-campaign', 'manual']) addLead(id);
    email('no-report', { deliveryStatus: null });
    email('soft', { deliveryStatus: 'Bounced', bounceType: 'soft' });
    email('spam', { deliveryStatus: 'FilteredSpam' });
    email('failed-send', { status: 'Failed', deliveryStatus: null });
    email('other-campaign', { campaignId: 'cmp-2' });
    // A Unibox reply or mailbox test to the lead has no step: not a campaign email.
    email('manual', { stepOrder: null });

    expect(await exportLeadSet(fake as any, 'cmp-1', 'delivered')).toEqual([]);
  });

  it('keeps a lead one mailbox was refused for and another delivered to', async () => {
    addLead('retried');
    email('retried', { deliveryStatus: 'Bounced', bounceType: 'soft' });
    email('retried');

    expect((await exportLeadSet(fake as any, 'cmp-1', 'delivered')).map((row) => [row.email, row.delivered])).toEqual([['retried@example.com', 1]]);
  });

  it('leaves out a lead that may no longer be emailed: bounced, unsubscribed, invalid, archived or suppressed', async () => {
    addLead('good');
    addLead('bounced', { status: 'Bounced' });
    addLead('unsubscribed', { status: 'Unsubscribed' });
    addLead('invalid', { validationStatus: 'Invalid' });
    addLead('archived', { isArchived: true });
    addLead('suppressed');
    for (const lead of leads) email(lead.id);
    suppressed = ['suppressed@example.com'];

    expect((await exportLeadSet(fake as any, 'cmp-1', 'delivered')).map((row) => row.email)).toEqual(['good@example.com']);
    expect((await leadSetCounts(fake as any, 'cmp-1')).delivered).toBe(1);
  });
});

describe('the Engaged list', () => {
  it('holds the leads who replied, opened or clicked, with what each did', async () => {
    for (const id of ['replied', 'opened', 'clicked', 'quiet']) addLead(id, { name: `Name ${id}`, company: 'Acme', jobTitle: 'Buyer' });
    for (const id of ['replied', 'quiet']) email(id);
    email('opened', {}, 'open');
    email('clicked', {}, 'click');
    reply('replied');
    reply('replied');

    const rows = await exportLeadSet(fake as any, 'cmp-1', 'engaged');

    expect(rows).toEqual([
      { email: 'clicked@example.com', name: 'Name clicked', company: 'Acme', jobTitle: 'Buyer', status: 'Neutral', delivered: 1, opened: true, clicked: true, replied: false },
      { email: 'opened@example.com', name: 'Name opened', company: 'Acme', jobTitle: 'Buyer', status: 'Neutral', delivered: 1, opened: true, clicked: false, replied: false },
      { email: 'replied@example.com', name: 'Name replied', company: 'Acme', jobTitle: 'Buyer', status: 'Neutral', delivered: 1, opened: false, clicked: false, replied: true },
    ]);
    expect(await leadSetCounts(fake as any, 'cmp-1')).toEqual({ delivered: 4, engaged: 3 });
  });

  it('counts no machine hit, auto-reply or engagement with another campaign', async () => {
    for (const id of ['scanner', 'out-of-office', 'other-campaign', 'other-reply']) addLead(id);
    // lib/botFilter records a security scanner's hits under their own event types
    email('scanner', {}, 'machine_open', 'machine_click');
    email('out-of-office');
    reply('out-of-office', { autoReply: 'out-of-office' });
    email('other-campaign', { campaignId: 'cmp-2' }, 'click');
    email('other-reply');
    reply('other-reply', { campaignId: 'cmp-2' });

    expect(await exportLeadSet(fake as any, 'cmp-1', 'engaged')).toEqual([]);
  });

  it('leaves out a lead who has since unsubscribed, so an opt-out never reaches a new list', async () => {
    addLead('left', { status: 'Unsubscribed' });
    email('left', {}, 'click');
    reply('left');

    expect(await exportLeadSet(fake as any, 'cmp-1', 'engaged')).toEqual([]);
  });
});

describe('adding a list to a lead group', () => {
  beforeEach(() => {
    for (const id of ['amy', 'bob', 'cat']) { addLead(id); email(id); }
  });

  it('adds the list to an existing group, leaving its members as they are', async () => {
    memberships = [{ leadId: 'amy', groupId: 'g-old' }, { leadId: 'someone-else', groupId: 'g-old' }];

    const result = await addLeadSetToGroup('cmp-1', 'delivered', { groupId: 'g-old' });

    expect(result).toEqual({ group: { id: 'g-old', name: 'Old Group' }, created: false, added: 2, alreadyIn: 1 });
    expect(memberships.filter((m) => m.groupId === 'g-old').map((m) => m.leadId).sort()).toEqual(['amy', 'bob', 'cat', 'someone-else']);
  });

  it('makes a new group for the list', async () => {
    const result = await addLeadSetToGroup('cmp-1', 'delivered', { groupName: '  Warm Leads  ' });

    expect(result).toEqual({ group: { id: 'g-2', name: 'Warm Leads' }, created: true, added: 3, alreadyIn: 0 });
    expect(memberships).toHaveLength(3);
  });

  it('enrolls the joining leads in the campaigns that target the group, as every way into a group does', async () => {
    campaigns.push({ id: 'cmp-next', userId: 'user-1', audienceCohort: 'g-old' });
    memberships = [{ leadId: 'amy', groupId: 'g-old' }];

    await addLeadSetToGroup('cmp-1', 'delivered', { groupId: 'g-old' });

    // amy was a member already, so only the two who joined are enrolled, at step 1.
    expect(enrollments).toEqual([
      { leadId: 'bob', campaignId: 'cmp-next', status: 'Active', currentSequenceStep: 1 },
      { leadId: 'cat', campaignId: 'cmp-next', status: 'Active', currentSequenceStep: 1 },
    ]);
    expect(await campaignsByGroup(fake as any)).toEqual({ 'g-old': 1 });
  });

  it('refuses a taken name, a group that is gone, and a request that names neither or both', async () => {
    await expect(addLeadSetToGroup('cmp-1', 'delivered', { groupName: 'Old Group' })).rejects.toMatchObject({
      status: 400, message: 'A lead group with this name already exists. Choose it from the list instead.',
    });
    await expect(addLeadSetToGroup('cmp-1', 'delivered', { groupId: 'g-gone' })).rejects.toMatchObject({ status: 404 });
    for (const target of [{}, { groupName: '   ' }, { groupId: 'g-old', groupName: 'Another' }]) {
      await expect(addLeadSetToGroup('cmp-1', 'delivered', target)).rejects.toMatchObject({
        status: 400, message: 'Choose an existing lead group or name a new one.',
      });
    }
    expect(memberships).toEqual([]);
    expect(groups).toHaveLength(1);
  });

  it('adds a long list in batches, each with its enrollments in one transaction', async () => {
    leads = [];
    dispatches = [];
    for (let i = 0; i < GROUP_ADD_BATCH + 5; i++) { addLead(`lead${i}`); email(`lead${i}`); }

    const result = await addLeadSetToGroup('cmp-1', 'delivered', { groupName: 'Everyone' });

    expect(result.added).toBe(GROUP_ADD_BATCH + 5);
    expect(fake.$transaction).toHaveBeenCalledTimes(2);
    expect(fake.leadGroupMembership.createMany.mock.calls.map(([args]: any) => args.data.length)).toEqual([GROUP_ADD_BATCH, 5]);
  });
});

describe('GET and POST /api/campaigns/[id]/leads', () => {
  const params = { params: Promise.resolve({ id: 'cmp-1' }) };
  const get = (query = '') => GET(new NextRequest(`http://localhost/api/campaigns/cmp-1/leads${query}`), params);
  const post = (body: unknown) => POST(new NextRequest('http://localhost/api/campaigns/cmp-1/leads', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }), params);

  beforeEach(() => {
    addLead('amy');
    email('amy', {}, 'open');
  });

  it('answers the count of each list and the campaigns that target each group', async () => {
    campaigns.push({ id: 'cmp-next', userId: 'user-1', audienceCohort: 'group_g-old' });

    const res = await get();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ counts: { delivered: 1, engaged: 1 }, groupCampaigns: { 'g-old': 1 } });
  });

  it('answers the leads of the list asked for, and refuses a list it does not know', async () => {
    const res = await get('?set=engaged');
    expect((await res.json()).leads).toEqual([
      { email: 'amy@example.com', name: '', company: '', jobTitle: '', status: 'Neutral', delivered: 1, opened: true, clicked: false, replied: false },
    ]);

    const bad = await get('?set=everyone');
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe('set must be one of delivered, engaged.');
    expect(isLeadSet('delivered')).toBe(true);
    expect(isLeadSet('toString')).toBe(false);
  });

  it("keeps another user's campaign from a user who is not an admin, and answers 404 for none", async () => {
    campaigns[0].userId = 'user-2';
    expect((await get()).status).toBe(403);
    expect((await post({ set: 'delivered', groupName: 'Mine' })).status).toBe(403);
    expect(groups).toHaveLength(1);

    vi.mocked(getSession).mockResolvedValue({ id: 'admin-1', name: 'Admin', email: 'admin@example.com', role: 'ADMIN' } as any);
    expect((await get()).status).toBe(200);

    campaigns = [];
    expect((await get()).status).toBe(404);
  });

  it('adds a list to a group and answers what it did, with the reason when it is refused', async () => {
    const res = await post({ set: 'delivered', groupName: 'Warm Leads' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ group: { id: 'g-2', name: 'Warm Leads' }, created: true, added: 1, alreadyIn: 0 });

    const taken = await post({ set: 'delivered', groupName: 'Warm Leads' });
    expect(taken.status).toBe(400);
    expect((await taken.json()).error).toBe('A lead group with this name already exists. Choose it from the list instead.');

    expect((await post({ set: 'everyone', groupName: 'X' })).status).toBe(400);
    expect((await post(['delivered'])).status).toBe(400);
  });
});
