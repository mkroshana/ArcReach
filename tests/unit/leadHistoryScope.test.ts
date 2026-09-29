import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('../../lib/db', () => ({
  prisma: {
    lead: { findUnique: vi.fn() },
    inboundResponse: { findMany: vi.fn() },
    emailDispatch: { findMany: vi.fn() },
    suppressedEmail: { findMany: vi.fn() },
  },
}));

vi.mock('../../lib/session', () => ({
  getSession: vi.fn(),
}));

vi.mock('../../lib/imapService', () => ({
  syncMailboxReplies: vi.fn(),
  getActiveImapAccounts: vi.fn(),
}));

import { prisma } from '../../lib/db';
import { getSession } from '../../lib/session';
import { getActiveImapAccounts } from '../../lib/imapService';
import { GET as getLeads } from '../../app/api/leads/route';
import { GET as getUnibox } from '../../app/api/unibox/route';

const mockedPrisma = prisma as any;
const mockedSession = vi.mocked(getSession);

const USER = { id: 'user-1', name: 'User', email: 'user@example.com', role: 'USER' as const };
const RIVAL = { id: 'user-2', name: 'Rival', email: 'rival@example.com', role: 'USER' as const };
const ADMIN = { id: 'admin-1', name: 'Admin', email: 'admin@example.com', role: 'ADMIN' as const };

const LEAD_ID = '11111111-2222-3333-4444-555555555555';
const LEAD = { id: LEAD_ID, email: 'lead@example.com', name: 'Lead', status: 'Neutral' };

const MAILBOXES = [
  { id: 'mb-1', userId: 'user-1', emailAddress: 'one@acme.test' },
  { id: 'mb-2', userId: 'user-2', emailAddress: 'two@acme.test' },
  { id: 'mb-3', userId: 'user-3', emailAddress: 'three@acme.test' },
];

/** Full campaign rows; the routes should only ever return id and name. */
const CAMPAIGNS = [
  { id: 'cmp-1', userId: 'user-1', name: 'Launch', status: 'Active', sendSchedule: { days: ['Mon'] }, audienceCohort: 'Valid' },
  { id: 'cmp-2', userId: 'user-2', name: 'Rival Launch', status: 'Active', sendSchedule: { days: ['Tue'] }, audienceCohort: 'Valid' },
];

/**
 * lead-1's history with both users: campaign sends, manual sends, a legacy send with no
 * mailbox, a campaign send made before mailboxes were recorded, a sequence step sent from a
 * third user's mailbox, and a Unibox reply from user one's mailbox that was stamped with
 * user two's campaign because the inbound it answered was attributed to the lead's latest
 * campaign.
 */
const DISPATCHES = [
  { id: 'd-own-legacy-campaign', leadId: LEAD_ID, campaignId: 'cmp-1', senderAccountId: null, stepOrder: null, subject: 'Hello', body: 'early copy from user one campaign', sentAt: new Date('2026-08-30') },
  { id: 'd-own-campaign', leadId: LEAD_ID, campaignId: 'cmp-1', senderAccountId: 'mb-1', stepOrder: 1, subject: 'Hello', body: 'copy from user one campaign', sentAt: new Date('2026-09-01') },
  { id: 'd-own-manual', leadId: LEAD_ID, campaignId: null, senderAccountId: 'mb-1', stepOrder: null, subject: 'Hello', body: 'manual note from user one', sentAt: new Date('2026-09-04') },
  { id: 'd-other-campaign', leadId: LEAD_ID, campaignId: 'cmp-2', senderAccountId: 'mb-2', stepOrder: 1, subject: 'Hello', body: 'copy from user two campaign', sentAt: new Date('2026-09-02') },
  { id: 'd-other-manual', leadId: LEAD_ID, campaignId: null, senderAccountId: 'mb-2', stepOrder: null, subject: 'Hello', body: 'manual note from user two', sentAt: new Date('2026-09-05') },
  { id: 'd-legacy', leadId: LEAD_ID, campaignId: null, senderAccountId: null, stepOrder: null, subject: 'Hello', body: 'legacy manual send', sentAt: new Date('2026-09-06') },
  { id: 'd-own-unibox-other-campaign', leadId: LEAD_ID, campaignId: 'cmp-2', senderAccountId: 'mb-1', stepOrder: null, subject: 'Re: Hello', body: 'unibox answer from user one', sentAt: new Date('2026-09-08') },
  { id: 'd-own-step-third-mailbox', leadId: LEAD_ID, campaignId: 'cmp-1', senderAccountId: 'mb-3', stepOrder: 2, subject: 'Hello', body: 'second step from user one campaign', sentAt: new Date('2026-09-09') },
];

const REPLIES = [
  { id: 'r-own', leadId: LEAD_ID, campaignId: 'cmp-1', senderAccountId: 'mb-1', subject: 'Re: Hello', body: 'answer to user one', receivedAt: new Date('2026-09-03'), unread: true },
  { id: 'r-other', leadId: LEAD_ID, campaignId: 'cmp-2', senderAccountId: 'mb-2', subject: 'Re: Hello', body: 'answer to user two', receivedAt: new Date('2026-09-07'), unread: true },
];

const ENROLLMENTS = [
  { id: 'e-1', leadId: LEAD_ID, campaignId: 'cmp-1', status: 'Active' },
  { id: 'e-2', leadId: LEAD_ID, campaignId: 'cmp-2', status: 'Paused' },
];

/**
 * Text that must never reach user one. The other campaign's name is not listed: the
 * misattributed Unibox reply above still carries its label until replies are attributed
 * by thread headers.
 */
const OTHER_USER_TEXT = ['user two', 'legacy manual send'];

/** Text that must never reach user two, who owns the campaign the Unibox reply was stamped with. */
const USER_ONE_TEXT = ['user one', 'legacy manual send'];

/** Evaluates the subset of Prisma `where` the history scopes use against the tables above. */
function matches(row: Record<string, any>, where: any): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, cond]: [string, any]) => {
    if (key === 'OR') return cond.some((w: any) => matches(row, w));
    if (key === 'campaign') {
      const campaign = CAMPAIGNS.find((c) => c.id === row.campaignId);
      return !!campaign && matches(campaign, cond);
    }
    if (key === 'senderAccount') {
      const mailbox = MAILBOXES.find((m) => m.id === row.senderAccountId);
      return !!mailbox && matches(mailbox, cond);
    }
    if (cond !== null && typeof cond === 'object' && 'in' in cond) return cond.in.includes(row[key]);
    if (cond !== null && typeof cond === 'object' && 'not' in cond) return row[key] !== cond.not;
    return row[key] === cond;
  });
}

/** Loads a related campaign the way Prisma does: `true` is every column, `{ select }` only those listed. */
function includeCampaign(campaignId: string | null, sel: true | { select: Record<string, boolean> }) {
  const campaign = CAMPAIGNS.find((c) => c.id === campaignId);
  if (!campaign) return null;
  if (sel === true) return { ...campaign };
  return Object.fromEntries(Object.keys(sel.select).map((k) => [k, (campaign as any)[k]]));
}

function makeReq(path: string): NextRequest {
  return new NextRequest(`http://localhost${path}`, { method: 'GET' });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getActiveImapAccounts).mockResolvedValue([]);

  mockedPrisma.lead.findUnique.mockImplementation(async ({ where, include }: any) => {
    if (where.id !== LEAD_ID) return null;
    return {
      ...LEAD,
      dispatches: DISPATCHES
        .filter((d) => matches(d, include.dispatches.where))
        .map((d) => ({ ...d, campaign: includeCampaign(d.campaignId, include.dispatches.include.campaign), events: [] })),
      replies: REPLIES
        .filter((r) => matches(r, include.replies.where))
        .map((r) => ({ ...r, campaign: includeCampaign(r.campaignId, include.replies.include.campaign) })),
      groups: [],
    };
  });

  mockedPrisma.inboundResponse.findMany.mockImplementation(async ({ where, include }: any) => {
    const enrollments = include.lead.include.enrollments;
    return REPLIES.filter((r) => matches(r, where)).map((r) => ({
      ...r,
      lead: {
        ...LEAD,
        enrollments: ENROLLMENTS
          .filter((e) => matches(e, enrollments.where))
          .map((e) => ({ ...e, campaign: includeCampaign(e.campaignId, enrollments.include.campaign) })),
      },
      campaign: includeCampaign(r.campaignId, include.campaign),
      senderAccount: MAILBOXES.find((m) => m.id === r.senderAccountId) ?? null,
    }));
  });

  mockedPrisma.emailDispatch.findMany.mockImplementation(async ({ where }: any) =>
    DISPATCHES.filter((d) => matches(d, where)),
  );
  mockedPrisma.suppressedEmail.findMany.mockResolvedValue([]);
});

describe('GET /api/leads?id= history scope (M45)', () => {
  it('shows a user only their own campaign and manual dispatches and replies to their own mailboxes', async () => {
    mockedSession.mockResolvedValue(USER);
    const res = await getLeads(makeReq(`/api/leads?id=${LEAD_ID}`));
    expect(res.status).toBe(200);
    const lead = await res.json();

    expect(lead.dispatches.map((d: any) => d.id)).toEqual([
      'd-own-legacy-campaign', 'd-own-campaign', 'd-own-manual', 'd-own-unibox-other-campaign', 'd-own-step-third-mailbox',
    ]);
    expect(lead.replies.map((r: any) => r.id)).toEqual(['r-own']);
    const text = JSON.stringify(lead);
    for (const other of OTHER_USER_TEXT) expect(text).not.toContain(other);
  });

  it("hides a Unibox reply sent from another user's mailbox from the owner of the campaign it was stamped with", async () => {
    mockedSession.mockResolvedValue(RIVAL);
    const lead = await (await getLeads(makeReq(`/api/leads?id=${LEAD_ID}`))).json();

    expect(lead.dispatches.map((d: any) => d.id)).toEqual(['d-other-campaign', 'd-other-manual']);
    expect(lead.replies.map((r: any) => r.id)).toEqual(['r-other']);
    const text = JSON.stringify(lead);
    expect(text).not.toContain('d-own-unibox-other-campaign');
    expect(text).not.toContain('unibox answer from user one');
    for (const other of USER_ONE_TEXT) expect(text).not.toContain(other);
  });

  it("shows a send from the user's own mailbox even when it is stamped with another user's campaign", async () => {
    mockedSession.mockResolvedValue(USER);
    const lead = await (await getLeads(makeReq(`/api/leads?id=${LEAD_ID}`))).json();

    const sent = lead.dispatches.find((d: any) => d.id === 'd-own-unibox-other-campaign');
    expect(sent?.body).toBe('unibox answer from user one');
    expect(lead.dispatches.map((d: any) => d.id)).not.toContain('d-legacy');
  });

  it('returns only the campaign id and name the timeline shows', async () => {
    mockedSession.mockResolvedValue(USER);
    const lead = await (await getLeads(makeReq(`/api/leads?id=${LEAD_ID}`))).json();

    expect(lead.dispatches[1].campaign).toEqual({ id: 'cmp-1', name: 'Launch' });
    expect(lead.dispatches[2].campaign).toBeNull();
    expect(lead.replies[0].campaign).toEqual({ id: 'cmp-1', name: 'Launch' });
  });

  it('keeps full history for admins', async () => {
    mockedSession.mockResolvedValue(ADMIN);
    const lead = await (await getLeads(makeReq(`/api/leads?id=${LEAD_ID}`))).json();

    expect(lead.dispatches.map((d: any) => d.id).sort()).toEqual(DISPATCHES.map((d) => d.id).sort());
    expect(lead.replies.map((r: any) => r.id).sort()).toEqual(['r-other', 'r-own']);
    expect(lead.replies.find((r: any) => r.id === 'r-other').campaign).toEqual({ id: 'cmp-2', name: 'Rival Launch' });
  });
});

describe('GET /api/unibox history scope (M45)', () => {
  it("threads a user's own replies with only their own dispatches and enrollments", async () => {
    mockedSession.mockResolvedValue(USER);
    const res = await getUnibox(makeReq('/api/unibox'));
    expect(res.status).toBe(200);
    const threads = await res.json();

    expect(threads).toHaveLength(1);
    const [thread] = threads;
    expect(thread.messages.map((m: any) => m.id)).toEqual([
      'd-own-legacy-campaign', 'd-own-campaign', 'r-own', 'd-own-manual', 'd-own-unibox-other-campaign', 'd-own-step-third-mailbox',
    ]);
    expect(thread.lead.enrollments.map((e: any) => e.id)).toEqual(['e-1']);
    expect(thread.lead.enrollments[0].campaign).toEqual({ id: 'cmp-1', name: 'Launch' });
    expect(thread.messages.find((m: any) => m.id === 'r-own').campaign).toEqual({ id: 'cmp-1', name: 'Launch' });
    const text = JSON.stringify(threads);
    for (const other of OTHER_USER_TEXT) expect(text).not.toContain(other);
    expect(text).not.toContain('Rival Launch');
  });

  it("keeps the user's own Unibox reply in the thread when it is stamped with another user's campaign", async () => {
    mockedSession.mockResolvedValue(USER);
    const [thread] = await (await getUnibox(makeReq('/api/unibox'))).json();

    const sent = thread.messages.find((m: any) => m.id === 'd-own-unibox-other-campaign');
    expect(sent).toMatchObject({ type: 'outbound', body: 'unibox answer from user one' });
    expect(thread.messages.map((m: any) => m.id)).not.toContain('d-legacy');
  });

  it("leaves another user's Unibox reply out of the thread of the campaign owner it was stamped with", async () => {
    mockedSession.mockResolvedValue(RIVAL);
    const threads = await (await getUnibox(makeReq('/api/unibox'))).json();

    expect(threads).toHaveLength(1);
    const [thread] = threads;
    expect(thread.messages.map((m: any) => m.id)).toEqual(['d-other-campaign', 'd-other-manual', 'r-other']);
    expect(thread.lead.enrollments.map((e: any) => e.id)).toEqual(['e-2']);
    const text = JSON.stringify(threads);
    expect(text).not.toContain('d-own-unibox-other-campaign');
    expect(text).not.toContain('unibox answer from user one');
    for (const other of USER_ONE_TEXT) expect(text).not.toContain(other);
  });

  it('keeps every reply, dispatch and enrollment for admins', async () => {
    mockedSession.mockResolvedValue(ADMIN);
    const [thread] = await (await getUnibox(makeReq('/api/unibox'))).json();

    expect(thread.messages.map((m: any) => m.id).sort())
      .toEqual([...DISPATCHES.map((d) => d.id), 'r-other', 'r-own'].sort());
    expect(thread.lead.enrollments.map((e: any) => e.id)).toEqual(['e-1', 'e-2']);
  });

  it("carries the lead's suppression-list entry, whatever its CRM status says (H17)", async () => {
    mockedSession.mockResolvedValue(USER);
    const added = new Date('2026-08-01T09:00:00Z');
    mockedPrisma.suppressedEmail.findMany.mockResolvedValue([
      { email: LEAD.email, reason: 'Unsubscribed', source: 'unsubscribe-link', createdAt: added },
    ]);

    const [thread] = await (await getUnibox(makeReq('/api/unibox'))).json();

    expect(mockedPrisma.suppressedEmail.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { email: { in: [LEAD.email] } },
    }));
    expect(thread.lead).toMatchObject({
      status: 'Neutral',
      suppression: { reason: 'Unsubscribed', source: 'unsubscribe-link', createdAt: added.toISOString() },
    });
  });
});
