import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('../../lib/db', () => ({
  prisma: {
    lead: { delete: vi.fn(), deleteMany: vi.fn() },
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

beforeEach(() => {
  vi.clearAllMocks();
  mockedPrisma.lead.delete.mockResolvedValue({});
  mockedPrisma.lead.deleteMany.mockResolvedValue({ count: 0 });
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
    expect(mockedPrisma.lead.delete).not.toHaveBeenCalled();
    expect(mockedPrisma.lead.deleteMany).not.toHaveBeenCalled();
  });

  it('lets an ADMIN delete all leads', async () => {
    mockedSession.mockResolvedValue(ADMIN);
    const res = await deleteLeads(makeReq('/api/leads?all=true'));
    expect(res.status).toBe(200);
    expect(mockedPrisma.lead.deleteMany).toHaveBeenCalledWith({});
  });

  it('lets an ADMIN delete a single lead', async () => {
    mockedSession.mockResolvedValue(ADMIN);
    const res = await deleteLeads(makeReq('/api/leads?id=lead-1'));
    expect(res.status).toBe(200);
    expect(mockedPrisma.lead.delete).toHaveBeenCalledWith({ where: { id: 'lead-1' } });
  });

  it('lets an ADMIN bulk delete selected leads', async () => {
    mockedSession.mockResolvedValue(ADMIN);
    const res = await deleteLeads(makeReq('/api/leads', { ids: ['lead-1', 'lead-2'] }));
    expect(res.status).toBe(200);
    expect(mockedPrisma.lead.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['lead-1', 'lead-2'] } } });
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
    expect(mockedPrisma.lead.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['lead-1', 'lead-2'] } } });
    expect(mockedPrisma.leadGroup.delete).toHaveBeenCalledWith({ where: { id: 'group-1' } });
  });
});
