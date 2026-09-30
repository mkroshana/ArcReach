import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { matchesWhere, type Relations } from './helpers/prismaWhere';

/**
 * In-memory leads, groups, memberships, campaigns, enrollments and the
 * suppression list. The fake models evaluate the routes' real where clauses
 * (lib/campaignCohort, lib/sendEligibility) through helpers/prismaWhere,
 * following a lead's `groups` and an enrollment's `campaign`, enforce the
 * unique keys, and put every table back when a transaction's callback throws,
 * so the tests check the rows the routes leave behind.
 */
const db = vi.hoisted(() => {
  type Row = Record<string, any>;
  const tables: Record<string, Row[]> = {
    lead: [], leadGroup: [], leadGroupMembership: [], campaign: [], campaignEnrollment: [], suppressedEmail: [],
  };
  return { tables, client: {} as Record<string, any>, seq: { n: 0 } };
});

vi.mock('../../lib/db', () => ({ prisma: db.client }));

vi.mock('../../lib/session', () => ({
  getSession: vi.fn(),
}));

import { getSession } from '../../lib/session';
import { POST as postLead, PUT as putLead } from '../../app/api/leads/route';
import { POST as postBulk } from '../../app/api/leads/bulk/route';
import { DELETE as deleteMembership } from '../../app/api/leads/groups/memberships/route';

type Row = Record<string, any>;
const T = db.tables;

const UNIQUE_KEYS: Record<string, string[]> = {
  lead: ['email'],
  leadGroupMembership: ['leadId', 'groupId'],
  campaignEnrollment: ['leadId', 'campaignId'],
  suppressedEmail: ['email'],
};
const WITHOUT_ID = ['leadGroupMembership', 'suppressedEmail'];

const RELATIONS: Relations = {
  groups: (row) => T.leadGroupMembership.filter((m) => m.leadId === row.id),
  campaign: (row) => T.campaign.find((c) => c.id === row.campaignId) ?? null,
};

function insert(table: string, data: Row, skipDuplicates = false): Row | null {
  const row = { ...data };
  if (!WITHOUT_ID.includes(table) && row.id === undefined) row.id = `${table}-${++db.seq.n}`;
  const key = UNIQUE_KEYS[table];
  if (key && T[table].some((other) => key.every((k) => other[k] === row[k]))) {
    if (skipDuplicates) return null;
    throw new Error(`Unique constraint failed on ${table}`);
  }
  T[table].push(row);
  return row;
}

/** Only the selected scalar columns, as Prisma's `select` loads them. */
function project(row: Row, select?: Row): Row {
  if (!select) return { ...row };
  return Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k]]));
}

/** A lead with `include: { groups: { include: { group: true } } }`. */
function withGroups(lead: Row): Row {
  return {
    ...lead,
    groups: T.leadGroupMembership.filter((m) => m.leadId === lead.id)
      .map((m) => ({ ...m, group: T.leadGroup.find((g) => g.id === m.groupId) })),
  };
}

function model(table: string) {
  const find = (where: Row | undefined) => T[table].filter((row) => matchesWhere(row, where, RELATIONS));
  return {
    findMany: async ({ where, select }: Row = {}) => find(where).map((row) => project(row, select)),
    findFirst: async ({ where, select }: Row = {}) => {
      const [row] = find(where);
      return row ? project(row, select) : null;
    },
    createMany: async ({ data, skipDuplicates }: Row) => ({
      count: data.filter((d: Row) => insert(table, d, skipDuplicates)).length,
    }),
    updateMany: async ({ where, data }: Row) => {
      const rows = find(where);
      rows.forEach((row) => Object.assign(row, data));
      return { count: rows.length };
    },
  };
}

for (const table of Object.keys(T)) db.client[table] = model(table);

db.client.lead.create = async ({ data }: Row) => {
  const { groups, ...fields } = data;
  const lead = insert('lead', fields)!;
  for (const g of groups?.create || []) insert('leadGroupMembership', { leadId: lead.id, groupId: g.groupId });
  return withGroups(lead);
};

db.client.lead.update = async ({ where, data }: Row) => {
  const lead = T.lead.find((l) => l.id === where.id);
  if (!lead) throw new Error('Record to update not found.');
  const { groups, ...fields } = data;
  Object.assign(lead, fields);
  if (groups) {
    T.leadGroupMembership = T.leadGroupMembership.filter((m) => m.leadId !== lead.id);
    for (const g of groups.create) insert('leadGroupMembership', { leadId: lead.id, groupId: g.groupId });
  }
  return withGroups(lead);
};

db.client.leadGroupMembership.delete = async ({ where }: Row) => {
  const { leadId, groupId } = where.leadId_groupId;
  const index = T.leadGroupMembership.findIndex((m) => m.leadId === leadId && m.groupId === groupId);
  if (index === -1) throw new Error('Record to delete does not exist.');
  return T.leadGroupMembership.splice(index, 1)[0];
};

db.client.$transaction = async (fn: (tx: any) => Promise<unknown>) => {
  const snapshot = Object.fromEntries(Object.entries(T).map(([t, rows]) => [t, rows.map((r) => ({ ...r }))]));
  try {
    return await fn(db.client);
  } catch (err) {
    Object.assign(T, snapshot);
    throw err;
  }
};

const USER = { id: 'user-1', name: 'User', email: 'user@example.com', role: 'USER' as const };
const NEXT_STEP_AT = new Date('2026-10-02T09:00:00Z');

function req(method: string, path: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function lead(id: string, fields: Row = {}): Row {
  return { id, email: `${id}@acme.com`, status: 'Neutral', validationStatus: 'Valid', isArchived: false, ...fields };
}

function enrollment(leadId: string, campaignId: string, status: string, currentSequenceStep = 2): Row {
  return {
    id: `env-${leadId}-${campaignId}`, leadId, campaignId, status, currentSequenceStep,
    nextActionDate: status === 'Active' ? NEXT_STEP_AT : null,
  };
}

const enrollmentOf = (leadId: string, campaignId: string) =>
  T.campaignEnrollment.find((e) => e.leadId === leadId && e.campaignId === campaignId);
const enrolledIn = (campaignId: string) =>
  T.campaignEnrollment.filter((e) => e.campaignId === campaignId).map((e) => e.leadId).sort();
const groupsOf = (leadId: string) =>
  T.leadGroupMembership.filter((m) => m.leadId === leadId).map((m) => m.groupId).sort();

beforeEach(() => {
  for (const table of Object.keys(T)) T[table] = [];
  db.seq.n = 0;
  vi.mocked(getSession).mockResolvedValue(USER as any);
  vi.spyOn(console, 'error').mockImplementation(() => {});

  T.leadGroup.push({ id: 'g1', name: 'Q3 Prospects' }, { id: 'g2', name: 'Webinar' });
  T.campaign.push(
    { id: 'cmp-q3', status: 'Active', audienceCohort: 'g1' },
    { id: 'cmp-q3-draft', status: 'Draft', audienceCohort: 'group_g1' }, // legacy prefixed group id
    { id: 'cmp-q3-paused', status: 'Paused', audienceCohort: 'g1' },
    { id: 'cmp-webinar', status: 'Active', audienceCohort: 'g2' },
    { id: 'cmp-valid', status: 'Active', audienceCohort: 'Valid' },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /api/leads/bulk into a group (M25)', () => {
  beforeEach(() => {
    T.lead.push(
      lead('bob'),
      lead('carol'),
      lead('dave', { isArchived: true }),
      lead('erin', { status: 'Unsubscribed' }),
    );
    // Carol answered this campaign's first step before she was in the group
    T.campaignEnrollment.push(enrollment('carol', 'cmp-q3', 'Paused'));
    T.suppressedEmail.push({ email: 'gone@acme.com', reason: 'Unsubscribed', source: 'unsubscribe-link' });
  });

  it('puts leads already in the CRM in the group with the new ones and enrolls those that may be emailed', async () => {
    const res = await postBulk(req('POST', '/api/leads/bulk', {
      leads: ['Bob@Acme.com', 'carol@acme.com', 'dave@acme.com', 'erin@acme.com', 'new@acme.com', 'gone@acme.com']
        .map((email) => ({ email })),
      groupIds: ['g1'],
    }));

    expect(res.status).toBe(200);
    expect((await res.json()).outcomes).toEqual(['existing', 'existing', 'existing', 'existing', 'created', 'suppressed']);
    const newId = T.lead.find((l) => l.email === 'new@acme.com')!.id;
    const goneId = T.lead.find((l) => l.email === 'gone@acme.com')!.id;
    for (const id of ['bob', 'carol', 'dave', 'erin', newId, goneId]) expect(groupsOf(id)).toEqual(['g1']);

    // Active and Draft campaigns targeting the group, by its id or the legacy prefix
    expect(enrolledIn('cmp-q3')).toEqual(['bob', 'carol', newId].sort());
    expect(enrolledIn('cmp-q3-draft')).toEqual(['bob', 'carol', newId].sort());
    expect(enrollmentOf('bob', 'cmp-q3')).toMatchObject({ status: 'Active', currentSequenceStep: 1 });
    // A reply-paused enrollment is not restarted
    expect(enrollmentOf('carol', 'cmp-q3')).toEqual(enrollment('carol', 'cmp-q3', 'Paused'));
    // A paused campaign and campaigns for other audiences enroll nobody
    expect(enrolledIn('cmp-q3-paused')).toEqual([]);
    expect(enrolledIn('cmp-webinar')).toEqual([]);
    expect(enrolledIn('cmp-valid')).toEqual([]);
  });

  it('adds already-imported leads to the group when the same file is imported into it again', async () => {
    await postBulk(req('POST', '/api/leads/bulk', { leads: [{ email: 'new@acme.com' }] }));
    const newId = T.lead.find((l) => l.email === 'new@acme.com')!.id;
    expect(groupsOf(newId)).toEqual([]);

    const res = await postBulk(req('POST', '/api/leads/bulk', { leads: [{ email: 'new@acme.com' }], groupIds: ['g1', 'g2'] }));

    expect((await res.json()).outcomes).toEqual(['existing']);
    expect(groupsOf(newId)).toEqual(['g1', 'g2']);
    expect(enrollmentOf(newId, 'cmp-q3')).toMatchObject({ status: 'Active', currentSequenceStep: 1 });
    expect(enrollmentOf(newId, 'cmp-webinar')).toMatchObject({ status: 'Active', currentSequenceStep: 1 });
  });
});

describe('removing a lead from a group (M25)', () => {
  beforeEach(() => {
    T.lead.push(lead('bob'));
    T.leadGroupMembership.push({ leadId: 'bob', groupId: 'g1' }, { leadId: 'bob', groupId: 'g2' });
    T.campaignEnrollment.push(
      enrollment('bob', 'cmp-q3', 'Active'),
      enrollment('bob', 'cmp-q3-paused', 'Active'),
      enrollment('bob', 'cmp-q3-draft', 'Completed'),
      enrollment('bob', 'cmp-webinar', 'Active'),
      enrollment('bob', 'cmp-valid', 'Active'),
    );
  });

  it('pauses, never deletes, its Active enrollments in every campaign targeting the group', async () => {
    const res = await deleteMembership(req('DELETE', '/api/leads/groups/memberships?groupId=g1&leadId=bob'));

    expect(res.status).toBe(200);
    expect(groupsOf('bob')).toEqual(['g2']);
    expect(T.campaignEnrollment).toHaveLength(5);
    // Kept at its step, so its history and place in the sequence stay
    expect(enrollmentOf('bob', 'cmp-q3')).toEqual({ ...enrollment('bob', 'cmp-q3', 'Active'), status: 'Paused' });
    expect(enrollmentOf('bob', 'cmp-q3-paused')).toMatchObject({ status: 'Paused' });
    expect(enrollmentOf('bob', 'cmp-q3-draft')).toEqual(enrollment('bob', 'cmp-q3-draft', 'Completed'));
    // Still in the Webinar group, and the Valid cohort is not a group
    expect(enrollmentOf('bob', 'cmp-webinar')).toMatchObject({ status: 'Active' });
    expect(enrollmentOf('bob', 'cmp-valid')).toMatchObject({ status: 'Active' });
  });

  it('pauses the same way when the lead drawer takes the group away', async () => {
    const res = await putLead(req('PUT', '/api/leads', { id: 'bob', groupIds: ['g2'] }));

    expect(res.status).toBe(200);
    expect(groupsOf('bob')).toEqual(['g2']);
    expect(enrollmentOf('bob', 'cmp-q3')).toMatchObject({ status: 'Paused', currentSequenceStep: 2, nextActionDate: NEXT_STEP_AT });
    expect(enrollmentOf('bob', 'cmp-q3-paused')).toMatchObject({ status: 'Paused' });
    expect(enrollmentOf('bob', 'cmp-webinar')).toMatchObject({ status: 'Active' });
  });

  it('does not resume the paused enrollment when the lead is put back in the group', async () => {
    await deleteMembership(req('DELETE', '/api/leads/groups/memberships?groupId=g1&leadId=bob'));

    const res = await putLead(req('PUT', '/api/leads', { id: 'bob', groupIds: ['g2', 'g1'] }));

    expect(res.status).toBe(200);
    expect(groupsOf('bob')).toEqual(['g1', 'g2']);
    expect(enrollmentOf('bob', 'cmp-q3')).toMatchObject({ status: 'Paused', currentSequenceStep: 2 });
  });

  it('keeps the membership and pauses nothing when the membership does not exist', async () => {
    const res = await deleteMembership(req('DELETE', '/api/leads/groups/memberships?groupId=g1&leadId=someone-else'));

    expect(res.status).toBe(500);
    expect(enrollmentOf('bob', 'cmp-q3')).toMatchObject({ status: 'Active' });
  });
});

describe('adding a lead to a group (M25)', () => {
  it('enrolls it from the lead drawer in the campaigns of the group it joins, leaving the others alone', async () => {
    T.lead.push(lead('bob'));
    T.leadGroupMembership.push({ leadId: 'bob', groupId: 'g1' });
    T.campaignEnrollment.push(enrollment('bob', 'cmp-q3', 'Active'));

    const res = await putLead(req('PUT', '/api/leads', { id: 'bob', groupIds: ['g1', 'g2'] }));

    expect(res.status).toBe(200);
    expect(enrollmentOf('bob', 'cmp-webinar')).toMatchObject({ status: 'Active', currentSequenceStep: 1 });
    // Already a member of g1: its enrollment there goes on at its step
    expect(enrollmentOf('bob', 'cmp-q3')).toEqual(enrollment('bob', 'cmp-q3', 'Active'));
    expect(enrolledIn('cmp-q3-draft')).toEqual([]);
  });

  it('enrolls no lead that may not be emailed', async () => {
    T.lead.push(lead('erin', { status: 'Unsubscribed' }), lead('ivan', { validationStatus: 'Invalid' }), lead('sam'));
    T.suppressedEmail.push({ email: 'sam@acme.com', reason: 'HardBounce', source: 'delivery-webhook' });

    for (const id of ['erin', 'ivan', 'sam']) {
      const res = await putLead(req('PUT', '/api/leads', { id, groupIds: ['g2'] }));
      expect(res.status).toBe(200);
      expect(groupsOf(id)).toEqual(['g2']);
    }
    expect(enrolledIn('cmp-webinar')).toEqual([]);
  });

  it('enrolls a lead created by Add Lead in the Active and Draft campaigns of its group', async () => {
    const res = await postLead(req('POST', '/api/leads', {
      name: 'Jane', email: 'jane@acme.com', validationStatus: 'Unverified', groupIds: ['g1'],
    }));

    expect(res.status).toBe(200);
    const { id } = await res.json();
    expect(enrollmentOf(id, 'cmp-q3')).toMatchObject({ status: 'Active', currentSequenceStep: 1 });
    expect(enrollmentOf(id, 'cmp-q3-draft')).toMatchObject({ status: 'Active', currentSequenceStep: 1 });
    expect(enrollmentOf(id, 'cmp-q3-paused')).toBeUndefined();
    expect(enrollmentOf(id, 'cmp-webinar')).toBeUndefined();
  });
});
