import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('../../lib/db', () => ({
  prisma: {
    $queryRaw: vi.fn(),
    lead: { findMany: vi.fn() },
    suppressedEmail: { findMany: vi.fn() },
  },
}));

vi.mock('../../lib/session', () => ({
  getSession: vi.fn(),
}));

import { prisma } from '../../lib/db';
import { getSession } from '../../lib/session';
import { GET as getLeads } from '../../app/api/leads/route';
import { leadListWhere, LEAD_ROW_SELECT } from '../../lib/leadList';
import { LEAD_PAGE_SIZE, type LeadListQuery } from '../../lib/leadView';

const mockedPrisma = prisma as any;
const USER = { id: 'user-1', name: 'User', email: 'user@example.com', role: 'USER' as const };

const query = (fields: Partial<LeadListQuery> = {}): LeadListQuery => ({
  view: 'leads', search: '', status: 'All', groupIds: [], page: 1, pageSize: LEAD_PAGE_SIZE, ...fields,
});

function makeReq(path: string): NextRequest {
  return new NextRequest(`http://localhost${path}`, { method: 'GET' });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue(USER as any);
  mockedPrisma.suppressedEmail.findMany.mockResolvedValue([]);
});

describe('the leads list filter in the database (M42)', () => {
  it('lists unarchived leads on the Leads tab and archived ones on the Archived tab, and nothing else unless asked', () => {
    const leads = leadListWhere(query());
    expect(leads.text).toBe('l."isArchived" = $1');
    expect(leads.values).toEqual([false]);
    expect(leadListWhere(query({ view: 'archived' })).values).toEqual([true]);
  });

  it('lists unarchived leads on the suppression list, Bounced, Unsubscribed or Invalid on the Suppressed tab', () => {
    const suppressed = leadListWhere(query({ view: 'suppressed' }));
    expect(suppressed.text).toBe(
      'l."isArchived" = $1 AND (s."email" IS NOT NULL OR l."status" IN (\'Bounced\', \'Unsubscribed\') OR l."validationStatus" = \'Invalid\')',
    );
    expect(suppressed.values).toEqual([false]);
  });

  it('searches the name, email and company ignoring case, with %, _ and \\ standing for themselves', () => {
    const searched = leadListWhere(query({ search: 'co_50%\\x' }));
    expect(searched.text).toBe('l."isArchived" = $1 AND (l."name" ILIKE $2 OR l."email" ILIKE $3 OR l."company" ILIKE $4)');
    expect(searched.values).toEqual([false, '%co\\_50\\%\\\\x%', '%co\\_50\\%\\\\x%', '%co\\_50\\%\\\\x%']);
  });

  it('filters a validation status by the column, and Bounced or Unsubscribed by the suppression list first, then the status', () => {
    const valid = leadListWhere(query({ status: 'Valid' }));
    expect(valid.text).toBe('l."isArchived" = $1 AND l."validationStatus"::text = $2');
    expect(valid.values).toEqual([false, 'Valid']);

    // A hard bounce on the list reads Bounced whatever the status; with no entry, a Bounced status does
    const bounced = leadListWhere(query({ status: 'Bounced' }));
    expect(bounced.text).toBe('l."isArchived" = $1 AND (s."reason"::text IN ($2) OR (s."email" IS NULL AND l."status"::text = $3))');
    expect(bounced.values).toEqual([false, 'HardBounce', 'Bounced']);

    // An opt-out and a spam complaint both read Unsubscribed
    expect(leadListWhere(query({ status: 'Unsubscribed' })).values).toEqual([false, 'Unsubscribed', 'Complaint', 'Unsubscribed']);
  });

  it('lists a group\'s unarchived members by membership alone, whatever the search and status filter say (L36)', () => {
    const members = leadListWhere(query({ view: 'group', groupIds: ['g-1'], search: 'jane', status: 'Valid' }));
    expect(members.text).toBe(
      'l."isArchived" = $1 AND EXISTS (SELECT 1 FROM "LeadGroupMembership" m WHERE m."leadId" = l."id" AND m."groupId" = $2)',
    );
    expect(members.values).toEqual([false, 'g-1']);
  });

  it('lists unarchived leads in more than one of the cross-checked groups, or of any groups when none is picked', () => {
    const picked = leadListWhere(query({ view: 'overlaps', groupIds: ['g-1', 'g-2'] }));
    expect(picked.text).toBe(
      'l."isArchived" = $1 AND (SELECT COUNT(*) FROM "LeadGroupMembership" m WHERE m."leadId" = l."id" AND m."groupId" IN ($2,$3)) > 1',
    );
    expect(picked.values).toEqual([false, 'g-1', 'g-2']);

    const any = leadListWhere(query({ view: 'overlaps' }));
    expect(any.text).toBe('l."isArchived" = $1 AND (SELECT COUNT(*) FROM "LeadGroupMembership" m WHERE m."leadId" = l."id") > 1');
  });
});

describe('GET /api/leads pages a table (M42)', () => {
  const rows = {
    a: { id: 'a', email: 'a@acme.com', name: 'Ann', status: 'Unsubscribed', validationStatus: 'Valid', groups: [] },
    // Opted out, then marked Not_Interested: the list still shows the suppression (H17)
    b: { id: 'b', email: 'b@acme.com', name: 'Bob', status: 'Not_Interested', validationStatus: 'Valid', groups: [{ groupId: 'g-1', group: { id: 'g-1', name: 'June' } }] },
  };

  it('counts and pages the list in the database and answers one page with each lead\'s suppression-list entry', async () => {
    const listedAt = new Date('2026-09-01T00:00:00Z');
    mockedPrisma.$queryRaw
      .mockResolvedValueOnce([{ total: 12, leadCount: 60000 }])
      .mockResolvedValueOnce([{ id: 'b' }]);
    mockedPrisma.lead.findMany.mockResolvedValue([rows.b]);
    mockedPrisma.suppressedEmail.findMany.mockResolvedValue([
      { email: 'b@acme.com', reason: 'Unsubscribed', source: 'unsubscribe-link', createdAt: listedAt },
    ]);

    const res = await getLeads(makeReq('/api/leads?view=suppressed&q=acme&status=Unsubscribed&page=2'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      leads: [{ ...rows.b, suppression: { reason: 'Unsubscribed', source: 'unsubscribe-link', createdAt: listedAt.toISOString() } }],
      total: 12,
      page: 2,
      pageSize: LEAD_PAGE_SIZE,
      leadCount: 60000,
    });

    // The count and the page read the same filter; the page is the second 10 in address order
    const where = leadListWhere(query({ view: 'suppressed', search: 'acme', status: 'Unsubscribed' }));
    const [count, page] = mockedPrisma.$queryRaw.mock.calls.map((call: any[]) => call[0]);
    expect(count.text).toContain('FROM "Lead" l LEFT JOIN "SuppressedEmail" s ON s."email" = lower(l."email") WHERE ');
    expect(count.text).toContain('(SELECT COUNT(*)::int FROM "Lead") AS "leadCount"');
    expect(count.values).toEqual(where.values);
    expect(page.text).toContain('ORDER BY l."email" ASC');
    expect(page.values).toEqual([...where.values, LEAD_PAGE_SIZE, LEAD_PAGE_SIZE]);

    // Only the page's leads are read, with only the columns the tables show
    expect(mockedPrisma.lead.findMany).toHaveBeenCalledTimes(1);
    expect(mockedPrisma.lead.findMany).toHaveBeenCalledWith({ where: { id: { in: ['b'] } }, select: LEAD_ROW_SELECT });
    expect(LEAD_ROW_SELECT).not.toHaveProperty('customVariables');
    expect(LEAD_ROW_SELECT.groups).toEqual({ select: { groupId: true, group: { select: { id: true, name: true } } } });
  });

  it('keeps the database\'s address order and answers the new last page for a page past the end (L33)', async () => {
    mockedPrisma.$queryRaw
      .mockResolvedValueOnce([{ total: 21, leadCount: 21 }])
      .mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }]);
    // Prisma answers the page's rows in any order
    mockedPrisma.lead.findMany.mockResolvedValue([rows.b, rows.a]);

    const res = await getLeads(makeReq('/api/leads?page=9'));

    const body = await res.json();
    expect(body.page).toBe(3);
    expect(body.leads.map((l: any) => l.id)).toEqual(['a', 'b']);
    expect(body.leads.map((l: any) => l.suppression)).toEqual([null, null]);
    const page = mockedPrisma.$queryRaw.mock.calls[1][0];
    expect(page.values.slice(-2)).toEqual([LEAD_PAGE_SIZE, 2 * LEAD_PAGE_SIZE]);
  });

  it('reads no rows for an empty list', async () => {
    mockedPrisma.$queryRaw.mockResolvedValueOnce([{ total: 0, leadCount: 5 }]);

    const res = await getLeads(makeReq('/api/leads?view=group&groupId=g-empty&page=4'));

    expect(await res.json()).toEqual({ leads: [], total: 0, page: 1, pageSize: LEAD_PAGE_SIZE, leadCount: 5 });
    expect(mockedPrisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(mockedPrisma.lead.findMany).not.toHaveBeenCalled();
  });

  it('refuses a malformed list query with a 400 before reading anything', async () => {
    const res = await getLeads(makeReq('/api/leads?view=group'));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'The group view needs one groupId.' });
    expect(mockedPrisma.$queryRaw).not.toHaveBeenCalled();
  });
});
