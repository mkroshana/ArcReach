import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('../../lib/db', () => ({
  prisma: {
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
import { GET as getUnibox } from '../../app/api/unibox/route';

const mockedPrisma = prisma as any;

const USER = { id: 'user-1', name: 'User', email: 'user@example.com', role: 'USER' as const };

const L1 = '11111111-1111-1111-1111-111111111111';
const L2 = '22222222-2222-2222-2222-222222222222';
const L3 = '33333333-3333-3333-3333-333333333333';

/** A tracked campaign body, as the send engine stores it; the list must never carry one. */
const HTML_BODY = `<html><body>${'<p>Campaign copy with tracking</p>'.repeat(200)}</body></html>`;
const LONG_REPLY = `Happy to talk pricing. ${'More detail. '.repeat(300)}`;

const TABLES: Record<string, any[]> = {
  mailbox: [
    { id: 'mb-1', userId: 'user-1', emailAddress: 'one@acme.test', smtpPass: 'smtp-secret', imapPass: 'imap-secret' },
    { id: 'mb-2', userId: 'user-2', emailAddress: 'two@acme.test', smtpPass: 'smtp-secret-2', imapPass: 'imap-secret-2' },
  ],
  campaign: [
    { id: 'cmp-1', userId: 'user-1', name: 'Launch', status: 'Active' },
  ],
  lead: [
    { id: L1, email: 'ana@example.com', name: 'Ana', company: 'Acme', status: 'Interested', validationStatus: 'Valid', customVariables: { tier: 'gold' } },
    { id: L2, email: 'ben@example.com', name: 'Ben', company: 'Beta', status: 'Neutral', validationStatus: 'Valid', customVariables: null },
    { id: L3, email: 'cy@example.com', name: 'Cy', company: 'Gamma', status: 'Neutral', validationStatus: 'Valid', customVariables: null },
  ],
  enrollment: [
    { id: 'e-1', leadId: L1, campaignId: 'cmp-1', status: 'Paused', claimToken: 'token', lastError: 'boom' },
  ],
  reply: [
    { id: 'r-1', leadId: L1, campaignId: 'cmp-1', senderAccountId: 'mb-1', subject: 'Re: Pricing', body: 'First answer', receivedAt: new Date('2026-09-01T10:00:00Z'), unread: false, autoReply: null },
    { id: 'r-2', leadId: L1, campaignId: 'cmp-1', senderAccountId: 'mb-1', subject: 'RE: pricing', body: LONG_REPLY, receivedAt: new Date('2026-09-05T10:00:00Z'), unread: true, autoReply: null },
    { id: 'r-3', leadId: L2, campaignId: null, senderAccountId: 'mb-1', subject: 'Re: Demo', body: 'Demo works for me', receivedAt: new Date('2026-09-03T10:00:00Z'), unread: false, autoReply: null },
    { id: 'r-4', leadId: L3, campaignId: null, senderAccountId: 'mb-1', subject: 'Re: Intro', body: 'We have budget next quarter', receivedAt: new Date('2026-09-04T10:00:00Z'), unread: false, autoReply: 'out-of-office' },
    // Received on another user's mailbox: never listed, opened or exported for user one
    { id: 'r-foreign', leadId: L3, campaignId: null, senderAccountId: 'mb-2', subject: 'Re: Secret', body: 'foreign reply text', receivedAt: new Date('2026-09-09T10:00:00Z'), unread: true, autoReply: null },
  ],
  dispatch: [
    { id: 'd-1', leadId: L1, campaignId: 'cmp-1', senderAccountId: 'mb-1', stepOrder: 1, subject: 'Pricing', body: HTML_BODY, sentAt: new Date('2026-08-30T10:00:00Z') },
    // A Unibox reply to Ben after his reply: his thread's latest activity
    { id: 'd-2', leadId: L2, campaignId: null, senderAccountId: 'mb-1', stepOrder: null, subject: 'Re: Demo', body: 'Great, see you then', sentAt: new Date('2026-09-06T10:00:00Z') },
    // Under a subject no reply of Cy's has: in no thread
    { id: 'd-3', leadId: L3, campaignId: 'cmp-1', senderAccountId: 'mb-1', stepOrder: 1, subject: 'Other subject', body: HTML_BODY, sentAt: new Date('2026-09-10T10:00:00Z') },
    // Another user's send to Cy under his thread's subject
    { id: 'd-foreign', leadId: L3, campaignId: null, senderAccountId: 'mb-2', stepOrder: null, subject: 'Intro', body: 'foreign dispatch text', sentAt: new Date('2026-09-11T10:00:00Z') },
  ],
};

/** Each table's relations: `one` names the foreign key column, `many` the child's key pointing back. */
const RELATIONS: Record<string, Record<string, { table: string; one?: string; many?: string }>> = {
  reply: {
    lead: { table: 'lead', one: 'leadId' },
    senderAccount: { table: 'mailbox', one: 'senderAccountId' },
    campaign: { table: 'campaign', one: 'campaignId' },
  },
  dispatch: {
    lead: { table: 'lead', one: 'leadId' },
    senderAccount: { table: 'mailbox', one: 'senderAccountId' },
    campaign: { table: 'campaign', one: 'campaignId' },
  },
  lead: {
    replies: { table: 'reply', many: 'leadId' },
    enrollments: { table: 'enrollment', many: 'leadId' },
  },
  enrollment: { campaign: { table: 'campaign', one: 'campaignId' } },
  campaign: {},
  mailbox: {},
};

function related(table: string, row: any, key: string): any {
  const rel = RELATIONS[table][key];
  if (rel.one) return TABLES[rel.table].find((r) => r.id === row[rel.one!]) ?? null;
  return TABLES[rel.table].filter((r) => r[rel.many!] === row.id);
}

/** Evaluates the subset of a Prisma `where` the Unibox route uses. */
function matches(table: string, row: any, where: any): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, cond]: [string, any]) => {
    if (key === 'OR') return cond.some((w: any) => matches(table, row, w));
    if (key === 'AND') return cond.every((w: any) => matches(table, row, w));
    const rel = RELATIONS[table][key];
    if (rel?.one) {
      const target = related(table, row, key);
      return !!target && matches(rel.table, target, cond);
    }
    if (rel?.many) return related(table, row, key).some((child: any) => matches(rel.table, child, cond.some));
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
      if ('in' in cond) return cond.in.includes(row[key]);
      if ('not' in cond) return row[key] !== cond.not;
      if ('contains' in cond) {
        const value = String(row[key] ?? '');
        return cond.mode === 'insensitive' ? value.toLowerCase().includes(cond.contains.toLowerCase()) : value.includes(cond.contains);
      }
    }
    return row[key] === cond;
  });
}

/** Loads a row the way Prisma's `select` does: listed columns only, relations as selected. */
function project(table: string, row: any, select: any): any {
  const out: Record<string, unknown> = {};
  for (const [key, sel] of Object.entries<any>(select)) {
    if (!sel) continue;
    const rel = RELATIONS[table][key];
    if (!rel) { out[key] = row[key]; continue; }
    const target = related(table, row, key);
    if (rel.one) { out[key] = target && project(rel.table, target, sel.select); continue; }
    const children = target.filter((child: any) => matches(rel.table, child, sel.where)).map((child: any) => project(rel.table, child, sel.select));
    out[key] = sel.take === undefined ? children : children.slice(0, sel.take);
  }
  return out;
}

function findMany(table: string) {
  return async ({ where, select, orderBy }: any) => {
    expect(select).toBeDefined(); // Unibox never loads whole rows
    const rows = TABLES[table].filter((row) => matches(table, row, where));
    for (const order of [...[orderBy ?? []].flat()].reverse()) {
      const [[field, dir]] = Object.entries<string>(order);
      rows.sort((a, b) => (a[field] < b[field] ? -1 : a[field] > b[field] ? 1 : 0) * (dir === 'desc' ? -1 : 1));
    }
    return rows.map((row) => project(table, row, select));
  };
}

function get(path: string) {
  return getUnibox(new NextRequest(`http://localhost${path}`));
}

/** The findMany calls that loaded a body column. */
function bodyReads(model: any): any[] {
  return model.findMany.mock.calls.map(([args]: any[]) => args).filter((args: any) => args.select.body);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue(USER);
  vi.mocked(getActiveImapAccounts).mockResolvedValue([]);
  mockedPrisma.inboundResponse.findMany.mockImplementation(findMany('reply'));
  mockedPrisma.emailDispatch.findMany.mockImplementation(findMany('dispatch'));
  mockedPrisma.suppressedEmail.findMany.mockResolvedValue([]);
});

describe('GET /api/unibox thread list (H35)', () => {
  it('lists a page of threads, newest activity first, without loading any dispatch body', async () => {
    const res = await get('/api/unibox?limit=2');
    expect(res.status).toBe(200);
    const page = await res.json();

    expect(page.threads.map((t: any) => t.id)).toEqual([`${L2}-demo`, `${L1}-pricing`]);
    expect(page).toMatchObject({ total: 3, unreadCount: 1, nextOffset: 2 });
    // Ben's thread is dated and titled by the Unibox reply sent after his reply
    expect(page.threads[0]).toMatchObject({ subject: 'Re: Demo', receivedAt: '2026-09-06T10:00:00.000Z', unread: false });

    expect(bodyReads(mockedPrisma.emailDispatch)).toEqual([]);
    const text = JSON.stringify(page);
    expect(text).not.toContain('Campaign copy with tracking');
    expect(text).not.toContain('foreign');
  });

  it('reads reply bodies only for the listed threads, and sends the start of the latest one as the preview', async () => {
    const { threads } = await (await get('/api/unibox?limit=2')).json();

    const reads = bodyReads(mockedPrisma.inboundResponse);
    expect(reads).toHaveLength(1);
    expect(reads[0].where.id.in.sort()).toEqual(['r-2', 'r-3']);

    const pricing = threads.find((t: any) => t.id === `${L1}-pricing`);
    expect(pricing.preview).toBe(LONG_REPLY.substring(0, 2000));
    expect(pricing).not.toHaveProperty('messages');
    expect(pricing).not.toHaveProperty('body');
  });

  it('gives each thread only the lead, enrollment and mailbox fields the list shows', async () => {
    const { threads } = await (await get('/api/unibox?limit=2')).json();
    const pricing = threads.find((t: any) => t.id === `${L1}-pricing`);

    expect(pricing.lead).toEqual({
      id: L1, email: 'ana@example.com', name: 'Ana', status: 'Interested',
      enrollments: [{ id: 'e-1', status: 'Paused' }],
      suppression: null,
    });
    expect(pricing.senderAccount).toEqual({ id: 'mb-1', emailAddress: 'one@acme.test' });
    expect(pricing.senderAccountId).toBe('mb-1');
  });

  it('pages on from an offset', async () => {
    const page = await (await get('/api/unibox?offset=2&limit=2')).json();

    expect(page.threads.map((t: any) => t.id)).toEqual([`${L3}-intro`]);
    expect(page).toMatchObject({ total: 3, unreadCount: 1, nextOffset: null });
  });

  it('pages 50 threads at a time by default', async () => {
    const page = await (await get('/api/unibox')).json();

    expect(page.threads.map((t: any) => t.id)).toEqual([`${L2}-demo`, `${L1}-pricing`, `${L3}-intro`]);
    expect(page.nextOffset).toBeNull();
  });

  it('searches every thread on the server: lead name or email, reply subject or body', async () => {
    for (const [q, expected] of [
      ['BUDGET', [`${L3}-intro`]],
      ['ben@', [`${L2}-demo`]],
      ['ana', [`${L1}-pricing`]],
      ['pricing', [`${L1}-pricing`]],
      ['secret', []],
    ] as const) {
      const page = await (await get(`/api/unibox?q=${encodeURIComponent(q)}`)).json();
      expect(page.threads.map((t: any) => t.id)).toEqual(expected);
      expect(page.total).toBe(expected.length);
      // The New count covers the whole inbox, whatever the search
      expect(page.unreadCount).toBe(1);
    }
  });
});

describe('GET /api/unibox?thread= (H35)', () => {
  it("loads an opened thread's messages with their bodies, oldest first", async () => {
    const res = await get(`/api/unibox?thread=${encodeURIComponent(`${L1}-pricing`)}`);
    expect(res.status).toBe(200);
    const { id, messages } = await res.json();

    expect(id).toBe(`${L1}-pricing`);
    expect(messages.map((m: any) => [m.id, m.type])).toEqual([['d-1', 'outbound'], ['r-1', 'inbound'], ['r-2', 'inbound']]);
    expect(messages[0].body).toBe(HTML_BODY);
    expect(messages[2]).toMatchObject({ body: LONG_REPLY, unread: true, campaign: { id: 'cmp-1', name: 'Launch' }, senderAccount: { id: 'mb-1', emailAddress: 'one@acme.test' } });
    // Only this lead's history was read
    for (const model of [mockedPrisma.inboundResponse, mockedPrisma.emailDispatch]) {
      for (const [args] of model.findMany.mock.calls) expect(args.where.leadId).toBe(L1);
    }
  });

  it("keeps another user's dispatch out of an opened thread", async () => {
    const { messages } = await (await get(`/api/unibox?thread=${encodeURIComponent(`${L3}-intro`)}`)).json();

    expect(messages.map((m: any) => m.id)).toEqual(['r-4']);
    expect(messages[0].autoReply).toBe('out-of-office');
    expect(JSON.stringify(messages)).not.toContain('foreign');
  });

  it('answers 404 for a thread with no reply the caller can see', async () => {
    const res = await get(`/api/unibox?thread=${encodeURIComponent(`${L3}-secret`)}`);

    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).not.toContain('foreign');
  });
});

describe('GET /api/unibox?export=replies (H35)', () => {
  it("pages the list's replies with their bodies, thread by thread, for the CSV export", async () => {
    const res = await get('/api/unibox?export=replies');
    expect(res.status).toBe(200);
    const { replies, nextOffset } = await res.json();

    expect(replies.map((r: any) => r.id)).toEqual(['r-3', 'r-1', 'r-2', 'r-4']);
    expect(nextOffset).toBeNull();
    expect(replies[1]).toMatchObject({
      body: 'First answer',
      campaign: { id: 'cmp-1', name: 'Launch' },
      senderAccount: { id: 'mb-1', emailAddress: 'one@acme.test' },
      lead: { email: 'ana@example.com', name: 'Ana', company: 'Acme', status: 'Interested', enrollments: [{ campaign: { id: 'cmp-1', name: 'Launch' } }] },
    });
    expect(bodyReads(mockedPrisma.emailDispatch)).toEqual([]);
    expect(JSON.stringify(replies)).not.toContain('foreign');
  });

  it('exports only the threads matching the search', async () => {
    const { replies } = await (await get('/api/unibox?export=replies&q=ana')).json();

    expect(replies.map((r: any) => r.id)).toEqual(['r-1', 'r-2']);
  });
});
