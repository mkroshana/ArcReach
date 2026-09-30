import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { matchesWhere, type Relations } from './helpers/prismaWhere';

vi.mock('../../lib/db', () => ({
  prisma: {
    inboundResponse: { findMany: vi.fn(), updateMany: vi.fn(), count: vi.fn(), update: vi.fn(), findUnique: vi.fn() },
    emailDispatch: { findMany: vi.fn() },
    campaignEnrollment: { findMany: vi.fn(), updateMany: vi.fn() },
    lead: { findMany: vi.fn(), update: vi.fn() },
    suppressedEmail: { findMany: vi.fn() },
    $transaction: vi.fn(),
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
import { GET as getUnibox, PUT as putUnibox } from '../../app/api/unibox/route';

const mockedPrisma = prisma as any;

const USER = { id: 'user-1', name: 'User', email: 'user@example.com', role: 'USER' as const };
const ADMIN = { id: 'admin-1', name: 'Admin', email: 'admin@example.com', role: 'ADMIN' as const };

const L1 = '11111111-1111-1111-1111-111111111111';
const L2 = '22222222-2222-2222-2222-222222222222';

const NEXT_STEP_AT = new Date('2026-10-01T09:00:00Z');

/** A tracked campaign send, as the send engine stores it: markup, a tracked link and the open pixel. */
const TRACKED_BODY = '<html><head><style>p { color: red; }</style></head><body><p>Hi Bo,</p>'
  + '<p>Worth a <a href="https://app.test/api/track/click/d-q?url=https%3A%2F%2Facme.test">quick look</a>?</p>'
  + '<img src="https://app.test/api/track/open/d-q" width="1" height="1" alt=""></body></html>';

let TABLES: Record<string, any[]>;

function seed() {
  TABLES = {
    mailbox: [
      { id: 'mb-1', userId: 'user-1', emailAddress: 'one@acme.test' },
      { id: 'mb-2', userId: 'user-2', emailAddress: 'two@acme.test' },
    ],
    campaign: [
      { id: 'cmp-a', userId: 'user-1', name: 'Launch' },
      { id: 'cmp-b', userId: 'user-1', name: 'Nurture' },
      { id: 'cmp-c', userId: 'user-1', name: 'Webinar' },
      { id: 'cmp-rival', userId: 'user-2', name: 'Rival Launch' },
    ],
    lead: [
      { id: L1, email: 'ana@example.com', name: 'Ana', status: 'Interested', validationStatus: 'Valid', isArchived: false },
      { id: L2, email: 'bo@example.com', name: 'Bo', status: 'Neutral', validationStatus: 'Valid', isArchived: false },
    ],
    enrollment: [
      { id: 'e-a', leadId: L1, campaignId: 'cmp-a', status: 'Active', nextActionDate: NEXT_STEP_AT },
      { id: 'e-b', leadId: L1, campaignId: 'cmp-b', status: 'Completed', nextActionDate: null },
      { id: 'e-c', leadId: L1, campaignId: 'cmp-c', status: 'Bounced', nextActionDate: null },
      // Another user's campaign
      { id: 'e-rival', leadId: L1, campaignId: 'cmp-rival', status: 'Active', nextActionDate: NEXT_STEP_AT },
    ],
    reply: [
      { id: 'r-pricing', leadId: L1, campaignId: 'cmp-a', senderAccountId: 'mb-1', subject: 'Re: Pricing', body: 'How much?', receivedAt: new Date('2026-09-10T10:00:00Z'), unread: true, autoReply: null },
      { id: 'r-demo', leadId: L1, campaignId: 'cmp-rival', senderAccountId: 'mb-2', subject: 'AW: Demo', body: 'Gerne', receivedAt: new Date('2026-09-11T10:00:00Z'), unread: true, autoReply: null },
      // Titled only by a prefix: the thread's normalised subject is empty
      { id: 'r-bare-1', leadId: L1, campaignId: null, senderAccountId: 'mb-1', subject: 'Re:', body: 'Yes', receivedAt: new Date('2026-09-12T10:00:00Z'), unread: true, autoReply: null },
      { id: 'r-bare-2', leadId: L1, campaignId: null, senderAccountId: 'mb-1', subject: 'RE: ', body: 'And also', receivedAt: new Date('2026-09-13T10:00:00Z'), unread: true, autoReply: null },
      // Received on another user's mailbox
      { id: 'r-bare-rival', leadId: L1, campaignId: null, senderAccountId: 'mb-2', subject: 'Re:', body: 'Other inbox', receivedAt: new Date('2026-09-14T10:00:00Z'), unread: true, autoReply: null },
      // Bo answers "Quick question" from clients in several languages
      ...['AW: Quick question', 'SV: Quick question', 'Re[2]: Quick question', '答复：Quick question', 'RE : Quick question', 'Antw: Re: Quick question', 'TR: Quick question']
        .map((subject, i) => ({
          id: `r-q-${i}`, leadId: L2, campaignId: 'cmp-a', senderAccountId: 'mb-1', subject, body: `Answer ${i}`,
          receivedAt: new Date(`2026-09-0${i + 2}T10:00:00Z`), unread: false, autoReply: null,
        })),
    ],
    dispatch: [
      { id: 'd-q', leadId: L2, campaignId: 'cmp-a', senderAccountId: 'mb-1', stepOrder: 1, subject: 'Quick question', body: TRACKED_BODY, sentAt: new Date('2026-09-01T10:00:00Z') },
      { id: 'd-q-reply', leadId: L2, campaignId: 'cmp-a', senderAccountId: 'mb-1', stepOrder: null, subject: 'Re: Quick question', body: 'Thanks Bo,\nTuesday works.', sentAt: new Date('2026-09-20T10:00:00Z') },
    ],
    suppressedEmail: [],
  };
}

const RELATIONS: Relations = {
  lead: (row) => TABLES.lead.find((l) => l.id === row.leadId) ?? null,
  campaign: (row) => TABLES.campaign.find((c) => c.id === row.campaignId) ?? null,
  senderAccount: (row) => TABLES.mailbox.find((m) => m.id === row.senderAccountId) ?? null,
  replies: (row) => TABLES.reply.filter((r) => r.leadId === row.id),
  enrollments: (row) => TABLES.enrollment.filter((e) => e.leadId === row.id),
};

/** Loads a row the way Prisma's `select` does: listed columns only, relations as selected. */
function project(row: any, select: any): any {
  const out: Record<string, unknown> = {};
  for (const [key, sel] of Object.entries<any>(select)) {
    if (!sel) continue;
    if (key in RELATIONS && typeof sel === 'object') {
      const target = RELATIONS[key](row);
      if (Array.isArray(target)) {
        const children = target.filter((c) => matchesWhere(c, sel.where, RELATIONS)).map((c) => project(c, sel.select));
        out[key] = sel.take === undefined ? children : children.slice(0, sel.take);
      } else {
        out[key] = target && project(target, sel.select);
      }
      continue;
    }
    out[key] = row[key];
  }
  return out;
}

/** A model over one table: reads evaluate the route's where, writes change the rows in place. */
function model(table: string) {
  const find = (where: any) => TABLES[table].filter((row) => matchesWhere(row, where, RELATIONS));
  return {
    findMany: async ({ where, select, orderBy }: any) => {
      const rows = find(where);
      for (const order of [...[orderBy ?? []].flat()].reverse()) {
        const [[field, dir]] = Object.entries<string>(order);
        rows.sort((a, b) => (a[field] < b[field] ? -1 : a[field] > b[field] ? 1 : 0) * (dir === 'desc' ? -1 : 1));
      }
      return rows.map((row) => (select ? project(row, select) : { ...row }));
    },
    count: async ({ where }: any) => find(where).length,
    updateMany: async ({ where, data }: any) => {
      const rows = find(where);
      for (const row of rows) Object.assign(row, data);
      return { count: rows.length };
    },
  };
}

function put(body: unknown) {
  return putUnibox(new NextRequest('http://localhost/api/unibox', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

function get(path: string) {
  return getUnibox(new NextRequest(`http://localhost${path}`));
}

const statuses = () => Object.fromEntries(TABLES.enrollment.map((e) => [e.id, e.status]));
const enrollment = (id: string) => TABLES.enrollment.find((e) => e.id === id);
const unread = () => Object.fromEntries(TABLES.reply.filter((r) => r.leadId === L1).map((r) => [r.id, r.unread]));

beforeEach(() => {
  vi.clearAllMocks();
  seed();
  vi.mocked(getSession).mockResolvedValue(USER);
  vi.mocked(getActiveImapAccounts).mockResolvedValue([]);
  for (const [name, table] of [
    ['inboundResponse', 'reply'], ['emailDispatch', 'dispatch'], ['campaignEnrollment', 'enrollment'], ['lead', 'lead'], ['suppressedEmail', 'suppressedEmail'],
  ]) {
    const fake = model(table);
    for (const method of Object.keys(fake) as (keyof typeof fake)[]) {
      mockedPrisma[name][method]?.mockImplementation(fake[method]);
    }
  }
  // The array form: each write has already run, in order
  mockedPrisma.$transaction.mockImplementation(async (ops: Promise<unknown>[]) => Promise.all(ops));
});

describe('PUT /api/unibox Pause and Resume (M46)', () => {
  it("pauses only the caller's Active enrollments, leaving finished ones and other users' campaigns alone", async () => {
    const res = await put({ leadId: L1, normalizedSubject: 'pricing', enrollmentStatus: 'Paused' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      changed: 1,
      enrollments: [{ id: 'e-a', status: 'Paused' }, { id: 'e-b', status: 'Completed' }, { id: 'e-c', status: 'Bounced' }],
    });
    expect(statuses()).toEqual({ 'e-a': 'Paused', 'e-b': 'Completed', 'e-c': 'Bounced', 'e-rival': 'Active' });
    // The next step keeps its date, for Resume to pick up
    expect(enrollment('e-a')!.nextActionDate).toEqual(NEXT_STEP_AT);
  });

  it('resumes only Paused enrollments, due now when the pause cleared their next send date', async () => {
    enrollment('e-a')!.status = 'Paused';
    Object.assign(enrollment('e-b')!, { status: 'Paused', nextActionDate: null });
    enrollment('e-rival')!.status = 'Paused';

    const before = Date.now();
    const res = await put({ leadId: L1, normalizedSubject: 'pricing', enrollmentStatus: 'Active' });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, changed: 2 });
    expect(statuses()).toEqual({ 'e-a': 'Active', 'e-b': 'Active', 'e-c': 'Bounced', 'e-rival': 'Paused' });
    expect(enrollment('e-a')!.nextActionDate).toEqual(NEXT_STEP_AT);
    const due = enrollment('e-b')!.nextActionDate.getTime();
    expect(due).toBeGreaterThanOrEqual(before);
    expect(due).toBeLessThanOrEqual(Date.now());
  });

  it.each([
    ['is on the suppression list', () => TABLES.suppressedEmail.push({ email: 'ana@example.com', reason: 'Unsubscribed', source: 'unsubscribe-link', createdAt: new Date() })],
    ['has a Bounced status', () => { TABLES.lead[0].status = 'Bounced'; }],
    ['failed verification', () => { TABLES.lead[0].validationStatus = 'Invalid'; }],
    ['is archived', () => { TABLES.lead[0].isArchived = true; }],
  ])('never resumes a lead that %s, and says so', async (_, unsendable) => {
    unsendable();
    enrollment('e-a')!.status = 'Paused';

    const res = await put({ leadId: L1, normalizedSubject: 'pricing', enrollmentStatus: 'Active' });

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/^Sequence not resumed: this lead is on the suppression list/);
    expect(statuses()).toEqual({ 'e-a': 'Paused', 'e-b': 'Completed', 'e-c': 'Bounced', 'e-rival': 'Active' });
    expect(mockedPrisma.campaignEnrollment.updateMany).not.toHaveBeenCalled();
  });

  it.each(['Completed', 'Bounced', 'active', null])('refuses enrollmentStatus %j and writes nothing', async (enrollmentStatus) => {
    const res = await put({ leadId: L1, normalizedSubject: 'pricing', enrollmentStatus });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('enrollmentStatus must be one of Active, Paused.');
    expect(mockedPrisma.campaignEnrollment.updateMany).not.toHaveBeenCalled();
  });

  it("pauses an admin's thread only in the campaigns its replies came from", async () => {
    vi.mocked(getSession).mockResolvedValue(ADMIN);

    const res = await put({ leadId: L1, normalizedSubject: 'pricing', enrollmentStatus: 'Paused' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, changed: 1, enrollments: [{ id: 'e-a', status: 'Paused' }] });
    expect(statuses()).toEqual({ 'e-a': 'Paused', 'e-b': 'Completed', 'e-c': 'Bounced', 'e-rival': 'Active' });

    // The German "AW: Demo" thread is the other user's campaign
    await put({ leadId: L1, normalizedSubject: 'demo', enrollmentStatus: 'Paused' });
    expect(statuses()).toEqual({ 'e-a': 'Paused', 'e-b': 'Completed', 'e-c': 'Bounced', 'e-rival': 'Paused' });
  });

  it('changes nothing for an admin thread whose replies name no campaign', async () => {
    vi.mocked(getSession).mockResolvedValue(ADMIN);

    const res = await put({ leadId: L1, normalizedSubject: '', enrollmentStatus: 'Paused' });

    expect(await res.json()).toEqual({ success: true, changed: 0, enrollments: [] });
    expect(statuses()).toEqual({ 'e-a': 'Active', 'e-b': 'Completed', 'e-c': 'Bounced', 'e-rival': 'Active' });
  });

  it('requires an admin to name the thread', async () => {
    vi.mocked(getSession).mockResolvedValue(ADMIN);

    const res = await put({ leadId: L1, enrollmentStatus: 'Paused' });

    expect(res.status).toBe(400);
    expect(mockedPrisma.campaignEnrollment.updateMany).not.toHaveBeenCalled();
  });
});

describe('PUT /api/unibox mark as read (L18)', () => {
  it("marks a thread titled only 'Re:' read by the key the list gives it, and only the caller's replies in it", async () => {
    const before = await (await get('/api/unibox')).json();
    const bare = before.threads.find((t: any) => t.id === `${L1}-`);
    expect(bare).toMatchObject({ leadId: L1, normalizedSubject: '', unread: true });

    const res = await put({ leadId: bare.leadId, normalizedSubject: bare.normalizedSubject, unread: false });

    expect(res.status).toBe(200);
    expect(unread()).toEqual({
      'r-pricing': true, 'r-demo': true, 'r-bare-1': false, 'r-bare-2': false,
      // Unread in the other user's inbox
      'r-bare-rival': true,
    });
    const after = await (await get('/api/unibox')).json();
    expect(after.threads.find((t: any) => t.id === `${L1}-`).unread).toBe(false);
    expect(after.unreadCount).toBe(before.unreadCount - 1);
  });

  it('marks a named thread read and leaves the lead\'s other threads alone', async () => {
    await put({ leadId: L1, normalizedSubject: 'pricing', unread: false });

    expect(unread()).toEqual({ 'r-pricing': false, 'r-demo': true, 'r-bare-1': true, 'r-bare-2': true, 'r-bare-rival': true });
    expect(mockedPrisma.campaignEnrollment.updateMany).not.toHaveBeenCalled();
  });
});

describe('PUT /api/unibox single reply by id (M46)', () => {
  const ALL_UNREAD = { 'r-pricing': true, 'r-demo': true, 'r-bare-1': true, 'r-bare-2': true, 'r-bare-rival': true };

  it("refuses { responseId, unread }, leaving another user's reply unread and returning no lead or enrollments", async () => {
    // r-demo came in on the other user's mailbox
    const res = await put({ responseId: 'r-demo', unread: false });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'leadId is required.' });
    expect(unread()).toEqual(ALL_UNREAD);
    expect(mockedPrisma.inboundResponse.update).not.toHaveBeenCalled();
    expect(mockedPrisma.inboundResponse.updateMany).not.toHaveBeenCalled();
  });

  it('refuses to mark read or unread without naming the thread, even with a reply id', async () => {
    const res = await put({ leadId: L1, responseId: 'r-demo', unread: false });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/^normalizedSubject is required/);
    expect(unread()).toEqual(ALL_UNREAD);
    expect(mockedPrisma.inboundResponse.update).not.toHaveBeenCalled();
    expect(mockedPrisma.inboundResponse.updateMany).not.toHaveBeenCalled();
    expect(mockedPrisma.lead.update).not.toHaveBeenCalled();
  });
});

describe('GET /api/unibox threads', () => {
  it("shows a user's thread with the enrollments in their own campaigns (M46)", async () => {
    const { threads } = await (await get('/api/unibox')).json();
    const pricing = threads.find((t: any) => t.id === `${L1}-pricing`);

    expect(pricing.normalizedSubject).toBe('pricing');
    expect(pricing.lead.enrollments).toEqual([
      { id: 'e-a', status: 'Active' }, { id: 'e-b', status: 'Completed' }, { id: 'e-c', status: 'Bounced' },
    ]);
  });

  it("shows an admin's thread with only the enrollments in its replies' campaigns, the ones Pause acts on (M46)", async () => {
    vi.mocked(getSession).mockResolvedValue(ADMIN);
    const { threads } = await (await get('/api/unibox')).json();
    const byId = (id: string) => threads.find((t: any) => t.id === id);

    expect(byId(`${L1}-pricing`).lead.enrollments).toEqual([{ id: 'e-a', status: 'Active' }]);
    expect(byId(`${L1}-demo`).lead.enrollments).toEqual([{ id: 'e-rival', status: 'Active' }]);
    expect(byId(`${L1}-`).lead.enrollments).toEqual([]);
  });

  it('threads replies behind reply and forward prefixes in other languages with the email they answer (L20)', async () => {
    const { threads } = await (await get('/api/unibox')).json();

    expect(threads.filter((t: any) => t.leadId === L2).map((t: any) => t.id)).toEqual([`${L2}-quick question`]);
    const { messages } = await (await get(`/api/unibox?thread=${encodeURIComponent(`${L2}-quick question`)}`)).json();
    expect(messages.map((m: any) => m.id)).toEqual(['d-q', 'r-q-0', 'r-q-1', 'r-q-2', 'r-q-3', 'r-q-4', 'r-q-5', 'r-q-6', 'd-q-reply']);
  });

  it('gives a sent campaign email as its text, without markup, pixel or tracked link targets (L19)', async () => {
    const { messages } = await (await get(`/api/unibox?thread=${encodeURIComponent(`${L2}-quick question`)}`)).json();
    const sent = messages.find((m: any) => m.id === 'd-q');

    expect(sent).toMatchObject({ type: 'outbound', body: 'Hi Bo,\n\nWorth a quick look?' });
    // A plain-text Unibox reply stays as it was written
    expect(messages.find((m: any) => m.id === 'd-q-reply').body).toBe('Thanks Bo,\nTuesday works.');
  });
});
