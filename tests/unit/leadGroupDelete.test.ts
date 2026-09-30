import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('../../lib/db', () => ({
  prisma: {
    lead: { deleteMany: vi.fn(), findMany: vi.fn() },
    leadGroup: { delete: vi.fn() },
    leadGroupMembership: { findMany: vi.fn(), createMany: vi.fn() },
    campaign: { findMany: vi.fn() },
    campaignEnrollment: { createMany: vi.fn() },
    suppressedEmail: { findMany: vi.fn() },
  },
}));

vi.mock('../../lib/session', () => ({
  getSession: vi.fn(),
}));

import { prisma } from '../../lib/db';
import { getSession } from '../../lib/session';
import { DELETE as deleteGroup } from '../../app/api/leads/groups/route';

const mockedPrisma = prisma as any;
const mockedSession = vi.mocked(getSession);

const USER = { id: 'user-1', name: 'User', email: 'user@example.com', role: 'USER' as const };
const ADMIN = { id: 'admin-1', name: 'Admin', email: 'admin@example.com', role: 'ADMIN' as const };

type CampaignRow = { name: string; userId: string; audienceCohort: string; id?: string; status?: string };

/** The Campaign table the dependency query runs against. */
let campaigns: CampaignRow[];

function makeDelete(query: string): NextRequest {
  return new NextRequest(`http://localhost/api/leads/groups?${query}`, { method: 'DELETE' });
}

/** Asserts the route touched no lead, membership or group rows. */
function expectNothingDeleted() {
  expect(mockedPrisma.leadGroupMembership.findMany).not.toHaveBeenCalled();
  expect(mockedPrisma.leadGroupMembership.createMany).not.toHaveBeenCalled();
  expect(mockedPrisma.lead.deleteMany).not.toHaveBeenCalled();
  expect(mockedPrisma.leadGroup.delete).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  campaigns = [];
  mockedSession.mockResolvedValue(USER);
  mockedPrisma.lead.deleteMany.mockResolvedValue({ count: 2 });
  mockedPrisma.leadGroup.delete.mockResolvedValue({});
  mockedPrisma.leadGroupMembership.findMany.mockResolvedValue([{ leadId: 'lead-1' }, { leadId: 'lead-2' }]);
  mockedPrisma.leadGroupMembership.createMany.mockResolvedValue({ count: 2 });
  // Both moved leads may be emailed
  mockedPrisma.lead.findMany.mockResolvedValue([{ id: 'lead-1', email: 'one@example.com' }, { id: 'lead-2', email: 'two@example.com' }]);
  mockedPrisma.suppressedEmail.findMany.mockResolvedValue([]);
  mockedPrisma.campaignEnrollment.createMany.mockResolvedValue({ count: 2 });
  mockedPrisma.campaign.findMany.mockImplementation(async ({ where, select, orderBy }: any) => {
    // The Active and Draft campaigns that enroll the leads moved into the target group
    if (where.status) {
      expect(select).toEqual({ id: true, audienceCohort: true });
      return campaigns
        .filter((c) => where.audienceCohort.in.includes(c.audienceCohort) && where.status.in.includes(c.status))
        .map(({ id, audienceCohort }) => ({ id, audienceCohort }));
    }
    expect(select).toEqual({ name: true, userId: true });
    expect(orderBy).toEqual({ name: 'asc' });
    return campaigns
      .filter((c) => where.audienceCohort.in.includes(c.audienceCohort))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(({ name, userId }) => ({ name, userId }));
  });
});

describe('DELETE /api/leads/groups in-use guard (H29)', () => {
  it('refuses with 409 and deletes nothing while a campaign targets the group, whatever the lead action', async () => {
    campaigns = [{ name: 'Q3 Outreach', userId: 'user-1', audienceCohort: 'group-1' }];
    mockedSession.mockResolvedValue(ADMIN);
    for (const query of ['id=group-1', 'id=group-1&leadAction=KEEP', 'id=group-1&leadAction=MOVE&targetGroupId=group-2', 'id=group-1&leadAction=DELETE']) {
      const res = await deleteGroup(makeDelete(query));
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe(
        'Cannot delete this group while a campaign targets it: "Q3 Outreach". Point that campaign at another audience or delete it first.',
      );
    }
    expectNothingDeleted();
  });

  it('refuses while a campaign targets the group through the group_ prefixed id', async () => {
    campaigns = [{ name: 'Legacy', userId: 'user-1', audienceCohort: 'group_group-1' }];
    const res = await deleteGroup(makeDelete('id=group-1&leadAction=KEEP'));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('"Legacy"');
    expectNothingDeleted();
  });

  it('names at most five campaigns and counts the rest', async () => {
    campaigns = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((name) => ({ name, userId: 'user-1', audienceCohort: 'group-1' }));
    const res = await deleteGroup(makeDelete('id=group-1&leadAction=KEEP'));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(
      'Cannot delete this group while 7 campaigns target it: "A", "B", "C", "D", "E" and 2 more. Point those campaigns at another audience or delete them first.',
    );
  });

  it('only counts, never names, other users\' campaigns for a non-admin', async () => {
    campaigns = [
      { name: 'Mine', userId: 'user-1', audienceCohort: 'group-1' },
      { name: 'Secret Plan', userId: 'user-2', audienceCohort: 'group-1' },
    ];
    const res = await deleteGroup(makeDelete('id=group-1&leadAction=MOVE&targetGroupId=group-2'));
    expect(res.status).toBe(409);
    const { error } = await res.json();
    expect(error).toBe(
      'Cannot delete this group while 2 campaigns target it: "Mine" and 1 more. Point those campaigns at another audience or delete them first.',
    );
    expect(error).not.toContain('Secret Plan');
    expectNothingDeleted();
  });

  it('gives a non-admin a count alone when none of the targeting campaigns are theirs', async () => {
    campaigns = [{ name: 'Secret Plan', userId: 'user-2', audienceCohort: 'group-1' }];
    const res = await deleteGroup(makeDelete('id=group-1&leadAction=KEEP'));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(
      'Cannot delete this group while a campaign targets it. Point that campaign at another audience or delete it first.',
    );
  });

  it('names every user\'s campaigns for an admin', async () => {
    mockedSession.mockResolvedValue(ADMIN);
    campaigns = [
      { name: 'Mine', userId: 'admin-1', audienceCohort: 'group-1' },
      { name: 'Theirs', userId: 'user-2', audienceCohort: 'group-1' },
    ];
    const res = await deleteGroup(makeDelete('id=group-1&leadAction=DELETE'));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('"Mine", "Theirs"');
    expectNothingDeleted();
  });

  it('moves the leads and deletes the group once no campaign targets it', async () => {
    campaigns = [
      { name: 'Other Group', userId: 'user-1', audienceCohort: 'group-2', id: 'cmp-other', status: 'Active' },
      { name: 'Other Group Paused', userId: 'user-1', audienceCohort: 'group-2', id: 'cmp-paused', status: 'Paused' },
      { name: 'All Valid', userId: 'user-1', audienceCohort: 'Valid', id: 'cmp-valid', status: 'Active' },
    ];
    const res = await deleteGroup(makeDelete('id=group-1&leadAction=MOVE&targetGroupId=group-2'));
    expect(res.status).toBe(200);
    expect(mockedPrisma.leadGroupMembership.createMany).toHaveBeenCalledWith({
      data: [{ leadId: 'lead-1', groupId: 'group-2' }, { leadId: 'lead-2', groupId: 'group-2' }],
      skipDuplicates: true,
    });
    // The moved leads join the Active campaign targeting the target group (M25)
    expect(mockedPrisma.lead.findMany).toHaveBeenCalledTimes(1);
    expect(mockedPrisma.lead.findMany.mock.calls[0][0].where.AND[0]).toEqual({
      AND: [{ isArchived: false, groups: { some: { groupId: 'group-2' } } }, { id: { in: ['lead-1', 'lead-2'] } }],
    });
    expect(mockedPrisma.campaignEnrollment.createMany).toHaveBeenCalledTimes(1);
    const [{ data, skipDuplicates }] = mockedPrisma.campaignEnrollment.createMany.mock.calls[0];
    expect(skipDuplicates).toBe(true);
    expect(data.map((e: any) => [e.leadId, e.campaignId, e.status, e.currentSequenceStep]))
      .toEqual([['lead-1', 'cmp-other', 'Active', 1], ['lead-2', 'cmp-other', 'Active', 1]]);
    expect(mockedPrisma.leadGroup.delete).toHaveBeenCalledWith({ where: { id: 'group-1' } });
  });

  it('still refuses a USER deleting the group with its leads before looking up campaigns', async () => {
    const res = await deleteGroup(makeDelete('id=group-1&leadAction=DELETE'));
    expect(res.status).toBe(403);
    expect(mockedPrisma.campaign.findMany).not.toHaveBeenCalled();
    expectNothingDeleted();
  });
});
