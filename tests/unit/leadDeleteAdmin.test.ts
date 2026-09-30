import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('../../lib/db', () => ({
  prisma: {
    lead: { findMany: vi.fn(), deleteMany: vi.fn() },
    deletedLead: { createMany: vi.fn() },
    leadGroup: { delete: vi.fn() },
    leadGroupMembership: { findMany: vi.fn(), createMany: vi.fn() },
    campaign: { findMany: vi.fn() },
  },
}));

vi.mock('../../lib/session', () => ({
  getSession: vi.fn(),
}));

import { prisma } from '../../lib/db';
import { getSession } from '../../lib/session';
import { DELETE as deleteLeads } from '../../app/api/leads/route';
import { DELETE as deleteGroup } from '../../app/api/leads/groups/route';

const mockedPrisma = prisma as any;
const mockedSession = vi.mocked(getSession);

const USER = { id: 'user-1', name: 'User', email: 'user@example.com', role: 'USER' as const };
const ADMIN = { id: 'admin-1', name: 'Admin', email: 'admin@example.com', role: 'ADMIN' as const };

function makeReq(path: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: 'DELETE',
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
}

/** The Lead table the delete reads: lead-1 was emailed and has a merged-in alias, lead-2 was never emailed. */
const LEADS = [
  { id: 'lead-1', email: 'one@acme.com', aliases: [{ id: 'lead-1-old' }], _count: { dispatches: 2 } },
  { id: 'lead-2', email: 'two@acme.com', aliases: [], _count: { dispatches: 0 } },
];

/** Asserts the delete read `where`, kept lead-1's ids for its unsubscribe links and deleted `ids`. */
function expectDeleted(where: unknown, ids: string[]) {
  expect(mockedPrisma.lead.findMany).toHaveBeenCalledWith({
    where,
    select: { id: true, email: true, aliases: { select: { id: true } }, _count: { select: { dispatches: true } } },
    take: 5000,
  });
  if (ids.includes('lead-1')) {
    expect(mockedPrisma.deletedLead.createMany).toHaveBeenCalledWith({
      data: [{ id: 'lead-1', email: 'one@acme.com' }, { id: 'lead-1-old', email: 'one@acme.com' }],
      skipDuplicates: true,
    });
  } else {
    expect(mockedPrisma.deletedLead.createMany).not.toHaveBeenCalled();
  }
  expect(mockedPrisma.lead.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ids } } });
  // The id list is written before the delete cascades the lead's aliases away
  if (ids.includes('lead-1')) {
    expect(mockedPrisma.deletedLead.createMany.mock.invocationCallOrder[0])
      .toBeLessThan(mockedPrisma.lead.deleteMany.mock.invocationCallOrder[0]);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedPrisma.lead.findMany.mockImplementation(async ({ where }: any) =>
    LEADS.filter((l) => where.id === undefined || (typeof where.id === 'string' ? where.id === l.id : where.id.in.includes(l.id))));
  mockedPrisma.lead.deleteMany.mockImplementation(async ({ where }: any) => ({ count: where.id.in.length }));
  mockedPrisma.deletedLead.createMany.mockImplementation(async ({ data }: any) => ({ count: data.length }));
  mockedPrisma.leadGroup.delete.mockResolvedValue({});
  mockedPrisma.leadGroupMembership.findMany.mockResolvedValue([{ leadId: 'lead-1' }, { leadId: 'lead-2' }]);
  mockedPrisma.leadGroupMembership.createMany.mockResolvedValue({ count: 2 });
  mockedPrisma.campaign.findMany.mockResolvedValue([]);
});

describe('DELETE /api/leads (H19)', () => {
  it('forbids a USER from deleting all, a single lead or a bulk selection', async () => {
    mockedSession.mockResolvedValue(USER);
    for (const req of [
      makeReq('/api/leads?all=true'),
      makeReq('/api/leads?id=lead-1'),
      makeReq('/api/leads', { ids: ['lead-1', 'lead-2'] }),
    ]) {
      const res = await deleteLeads(req);
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe('Forbidden. Admin role required.');
    }
    expect(mockedPrisma.lead.findMany).not.toHaveBeenCalled();
    expect(mockedPrisma.lead.deleteMany).not.toHaveBeenCalled();
    expect(mockedPrisma.deletedLead.createMany).not.toHaveBeenCalled();
  });

  it('lets an ADMIN delete all leads, keeping the ids of emailed ones (H18)', async () => {
    mockedSession.mockResolvedValue(ADMIN);
    const res = await deleteLeads(makeReq('/api/leads?all=true'));
    expect(res.status).toBe(200);
    expectDeleted({}, ['lead-1', 'lead-2']);
  });

  it('lets an ADMIN delete a single lead, keeping its ids (H18)', async () => {
    mockedSession.mockResolvedValue(ADMIN);
    const res = await deleteLeads(makeReq('/api/leads?id=lead-1'));
    expect(res.status).toBe(200);
    expectDeleted({ id: 'lead-1' }, ['lead-1']);
  });

  it('keeps no address for a lead that was never emailed', async () => {
    mockedSession.mockResolvedValue(ADMIN);
    const res = await deleteLeads(makeReq('/api/leads?id=lead-2'));
    expect(res.status).toBe(200);
    expectDeleted({ id: 'lead-2' }, ['lead-2']);
  });

  it('answers 404 for a single lead that does not exist', async () => {
    mockedSession.mockResolvedValue(ADMIN);
    const res = await deleteLeads(makeReq('/api/leads?id=nope'));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('Lead not found.');
    expect(mockedPrisma.lead.deleteMany).not.toHaveBeenCalled();
  });

  it('lets an ADMIN bulk delete selected leads, keeping the ids of emailed ones (H18)', async () => {
    mockedSession.mockResolvedValue(ADMIN);
    const res = await deleteLeads(makeReq('/api/leads', { ids: ['lead-1', 'lead-2'] }));
    expect(res.status).toBe(200);
    expectDeleted({ id: { in: ['lead-1', 'lead-2'] } }, ['lead-1', 'lead-2']);
  });

  it('deletes a large selection in rounds of 5000', async () => {
    mockedSession.mockResolvedValue(ADMIN);
    const many = Array.from({ length: 5001 }, (_, i) => ({ id: `bulk-${i}`, email: `b${i}@acme.com`, aliases: [], _count: { dispatches: 1 } }));
    let remaining = [...many];
    mockedPrisma.lead.findMany.mockImplementation(async ({ take }: any) => remaining.slice(0, take));
    mockedPrisma.lead.deleteMany.mockImplementation(async ({ where }: any) => {
      remaining = remaining.filter((l) => !where.id.in.includes(l.id));
      return { count: where.id.in.length };
    });

    const res = await deleteLeads(makeReq('/api/leads?all=true'));
    expect(res.status).toBe(200);
    expect(remaining).toHaveLength(0);
    expect(mockedPrisma.lead.deleteMany.mock.calls.map(([args]: any) => args.where.id.in.length)).toEqual([5000, 1]);
    expect(mockedPrisma.deletedLead.createMany.mock.calls.map(([args]: any) => args.data.length)).toEqual([5000, 1]);
  });
});

describe('DELETE /api/leads/groups (H19)', () => {
  it('forbids a USER from deleting a group together with its leads', async () => {
    mockedSession.mockResolvedValue(USER);
    const res = await deleteGroup(makeReq('/api/leads/groups?id=group-1&leadAction=DELETE'));
    expect(res.status).toBe(403);
    expect(mockedPrisma.lead.deleteMany).not.toHaveBeenCalled();
    expect(mockedPrisma.leadGroup.delete).not.toHaveBeenCalled();
  });

  it('still lets a USER delete a group while keeping or moving its leads', async () => {
    mockedSession.mockResolvedValue(USER);
    const keep = await deleteGroup(makeReq('/api/leads/groups?id=group-1&leadAction=KEEP'));
    expect(keep.status).toBe(200);
    const move = await deleteGroup(makeReq('/api/leads/groups?id=group-2&leadAction=MOVE&targetGroupId=group-3'));
    expect(move.status).toBe(200);
    expect(mockedPrisma.leadGroupMembership.createMany).toHaveBeenCalledTimes(1);
    expect(mockedPrisma.leadGroup.delete).toHaveBeenCalledTimes(2);
    expect(mockedPrisma.lead.deleteMany).not.toHaveBeenCalled();
  });

  it('lets an ADMIN delete a group together with its leads', async () => {
    mockedSession.mockResolvedValue(ADMIN);
    const res = await deleteGroup(makeReq('/api/leads/groups?id=group-1&leadAction=DELETE'));
    expect(res.status).toBe(200);
    expectDeleted({ id: { in: ['lead-1', 'lead-2'] } }, ['lead-1', 'lead-2']);
    expect(mockedPrisma.leadGroup.delete).toHaveBeenCalledWith({ where: { id: 'group-1' } });
  });
});
