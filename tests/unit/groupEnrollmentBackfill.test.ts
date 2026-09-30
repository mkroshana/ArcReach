import { describe, it, expect, vi, beforeEach } from 'vitest';
import { matchesWhere, type Relations } from './helpers/prismaWhere';

// lib/campaignCohort imports the app's client; the backfill is handed its own.
vi.mock('../../lib/db', () => ({ prisma: {} }));

import { findGroupEnrollmentGaps } from '../../lib/groupEnrollmentBackfill';

/**
 * In-memory campaigns, groups, leads, enrollments, dispatches, replies and
 * the suppression list. The fake client evaluates the backfill's real where
 * clauses (lib/groupEnrollmentBackfill, lib/campaignCohort, lib/sendEligibility)
 * through helpers/prismaWhere, following a lead's `groups`, and records every
 * write it is asked for.
 */
type Row = Record<string, any>;
let T: Record<string, Row[]>;

const RELATIONS: Relations = {
  groups: (row) => T.leadGroupMembership.filter((m) => m.leadId === row.id),
};

/** Only the selected columns, as Prisma's `select` loads them. */
function project(row: Row, select?: Row): Row {
  if (!select) return { ...row };
  return Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k]]));
}

function model(table: string) {
  return {
    findMany: vi.fn(async ({ where, select, distinct, orderBy }: Row = {}) => {
      let rows = T[table].filter((row) => matchesWhere(row, where, RELATIONS));
      if (orderBy) {
        const [[field, direction]] = Object.entries(orderBy) as [string, string][];
        rows = [...rows].sort((a, b) => String(a[field]).localeCompare(String(b[field])) * (direction === 'desc' ? -1 : 1));
      }
      if (distinct) {
        const seen = new Set<string>();
        rows = rows.filter((row) => {
          const key = JSON.stringify(distinct.map((field: string) => row[field]));
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      }
      return rows.map((row) => project(row, select));
    }),
    createMany: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
  };
}

function fakeClient(): Row {
  const client: Row = { $transaction: vi.fn(), $queryRaw: vi.fn() };
  for (const table of Object.keys(T)) client[table] = model(table);
  return client;
}

/** Every write the fake client can be asked for. */
function writes(client: Row) {
  return [
    client.$transaction, client.$queryRaw,
    ...Object.keys(T).flatMap((table) => [client[table].createMany, client[table].updateMany, client[table].deleteMany]),
  ];
}

function lead(id: string, fields: Row = {}): Row {
  return { id, email: `${id}@acme.com`, status: 'Neutral', validationStatus: 'Valid', isArchived: false, ...fields };
}

function campaign(id: string, name: string, status: string, audienceCohort: string, cohortSyncRequestedAt: Date | null = null): Row {
  return { id, name, status, audienceCohort, cohortSyncRequestedAt };
}

function enrollment(leadId: string, campaignId: string, status: string): Row {
  return { id: `env-${leadId}-${campaignId}`, leadId, campaignId, status, currentSequenceStep: 2, nextActionDate: null };
}

beforeEach(() => {
  T = {
    campaign: [
      campaign('cmp-q3', 'Q3 Outreach', 'Paused', 'g1'),
      campaign('cmp-q3-legacy', 'Q3 Legacy', 'Active', 'group_g1'), // legacy prefixed group id
      campaign('cmp-webinar', 'Webinar Follow-up', 'Draft', 'g2'),
      campaign('cmp-webinar-stopped', 'Webinar Stopped', 'Stopped', 'g2'),
      campaign('cmp-syncing', 'Syncing', 'Active', 'g2', new Date('2026-10-01T09:00:00Z')),
      campaign('cmp-orphan', 'Orphan', 'Paused', 'g-deleted'),
      campaign('cmp-valid', 'All Valid', 'Active', 'Valid'),
      campaign('cmp-unverified', 'All Unverified', 'Active', 'Unverified'),
    ],
    leadGroup: [{ id: 'g1', name: 'Q3 Prospects' }, { id: 'g2', name: 'Webinar' }],
    lead: [
      lead('ann'), lead('bob'), lead('cat'), lead('dan'),
      lead('eve', { isArchived: true }),
      lead('fay', { status: 'Unsubscribed' }),
      lead('gus', { validationStatus: 'Invalid' }),
      lead('hal'), // on the suppression list
      lead('ivy'),
      lead('jon'), // in no group
    ],
    leadGroupMembership: [
      ...['ann', 'bob', 'cat', 'dan', 'eve', 'fay', 'gus', 'hal'].map((leadId) => ({ leadId, groupId: 'g1' })),
      { leadId: 'ivy', groupId: 'g2' },
    ],
    suppressedEmail: [{ email: 'hal@acme.com', reason: 'HardBounce' }],
    campaignEnrollment: [
      enrollment('ann', 'cmp-q3', 'Active'),
      enrollment('ann', 'cmp-q3-legacy', 'Paused'), // paused on a reply, still enrolled
      enrollment('ivy', 'cmp-webinar-stopped', 'Completed'),
    ],
    emailDispatch: [
      // Cat was emailed by Q3 Outreach and has no enrollment there any more
      { id: 'd1', leadId: 'cat', campaignId: 'cmp-q3', status: 'Sent' },
      { id: 'd2', leadId: 'cat', campaignId: 'cmp-q3', status: 'Failed' },
      { id: 'd3', leadId: 'bob', campaignId: 'cmp-webinar', status: 'Sent' }, // another campaign's mail does not count
      { id: 'd4', leadId: null, campaignId: null, status: 'Sent' }, // a mailbox test send
    ],
    inboundResponse: [{ id: 'r1', leadId: 'dan', campaignId: 'cmp-q3' }],
  };
});

const summary = (gaps: Awaited<ReturnType<typeof findGroupEnrollmentGaps>>) =>
  gaps.map((gap) => [gap.name, gap.status, gap.enrollable, gap.toEnroll, gap.contacted]);

describe('findGroupEnrollmentGaps', () => {
  it('finds, in campaigns of every status, the leads of the group that may be emailed and have no enrollment', async () => {
    const client = fakeClient();

    const gaps = await findGroupEnrollmentGaps(client as any);

    // By name; the Valid and Unverified audiences are not groups. Eve (archived), Fay
    // (unsubscribed), Gus (invalid) and Hal (suppressed) may not be emailed, and an
    // enrollment in any status, Ann's reply-paused one and Ivy's completed one, counts.
    expect(summary(gaps)).toEqual([
      ['Orphan', 'Paused', 0, [], 0],
      ['Q3 Legacy', 'Active', 4, ['bob', 'cat', 'dan'], 0],
      ['Q3 Outreach', 'Paused', 4, ['bob'], 2],
      ['Syncing', 'Active', 1, ['ivy'], 0],
      ['Webinar Follow-up', 'Draft', 1, ['ivy'], 0],
      ['Webinar Stopped', 'Stopped', 1, [], 0],
    ]);
    for (const write of writes(client)) expect(write).not.toHaveBeenCalled();
  });

  it('leaves alone a lead the campaign emailed or had a reply from, so no one is sent step 1 twice', async () => {
    const gaps = await findGroupEnrollmentGaps(fakeClient() as any);

    // Cat was emailed and Dan replied to Q3 Outreach; neither counts there, but both do in Q3 Legacy
    expect(gaps.find((gap) => gap.campaignId === 'cmp-q3')).toMatchObject({ toEnroll: ['bob'], contacted: 2 });
    expect(gaps.find((gap) => gap.campaignId === 'cmp-q3-legacy')).toMatchObject({ toEnroll: ['bob', 'cat', 'dan'], contacted: 0 });
  });

  it('names the group by its id or the legacy prefix, and flags a group that is gone and a sync still pending', async () => {
    const gaps = await findGroupEnrollmentGaps(fakeClient() as any);
    const byId = new Map(gaps.map((gap) => [gap.campaignId, gap]));

    expect(byId.get('cmp-q3')).toMatchObject({ groupId: 'g1', groupName: 'Q3 Prospects', syncPending: false });
    expect(byId.get('cmp-q3-legacy')).toMatchObject({ audienceCohort: 'group_g1', groupId: 'g1', groupName: 'Q3 Prospects' });
    expect(byId.get('cmp-orphan')).toMatchObject({ groupId: 'g-deleted', groupName: null });
    expect(byId.get('cmp-syncing')).toMatchObject({ groupName: 'Webinar', syncPending: true });
  });

  it('reads only the campaigns asked for, and never one whose audience is not a group', async () => {
    const gaps = await findGroupEnrollmentGaps(fakeClient() as any, ['cmp-q3', 'cmp-valid', 'cmp-missing']);

    expect(gaps.map((gap) => gap.campaignId)).toEqual(['cmp-q3']);
  });
});
