import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { matchesWhere } from './helpers/prismaWhere';

// Fake IMAP server holding one INBOX of messages with raw header lines, all new since
// the mailbox's checkpoint.
const server = vi.hoisted(() => ({
  messages: [] as { uid: number; headers: string[]; body: string }[],
}));

vi.mock('tls', () => {
  const answer = (data: string): string => {
    const [tag, verb, sub, ...rest] = data.trim().split(' ');
    if (verb === 'LOGIN') return `${tag} OK LOGIN completed\r\n`;
    if (verb === 'LOGOUT') return '';
    if (verb === 'EXAMINE') {
      const uidNext = Math.max(0, ...server.messages.map((m) => m.uid)) + 1;
      return `* ${server.messages.length} EXISTS\r\n* OK [UIDVALIDITY 5] UIDs valid\r\n` +
        `* OK [UIDNEXT ${uidNext}] Predicted next UID\r\n${tag} OK [READ-ONLY] EXAMINE completed\r\n`;
    }
    if (verb === 'UID' && sub === 'SEARCH') {
      const after = Number(rest[1].split(':')[0]) - 1;
      const uids = server.messages.filter((m) => m.uid > after).map((m) => ` ${m.uid}`).join('');
      return `* SEARCH${uids}\r\n${tag} OK SEARCH completed\r\n`;
    }
    if (verb === 'UID' && sub === 'FETCH') {
      const uids = rest[0].split(',').map(Number);
      const out = server.messages.filter((m) => uids.includes(m.uid)).map((m, i) => {
        if (!data.includes('HEADER.FIELDS')) {
          return `* ${i + 1} FETCH (UID ${m.uid} BODY[TEXT] {${Buffer.byteLength(m.body)}}\r\n${m.body})\r\n`;
        }
        const block = [...m.headers, '', ''].join('\r\n');
        return `* ${i + 1} FETCH (UID ${m.uid} BODY[HEADER.FIELDS (FROM SUBJECT)] {${Buffer.byteLength(block)}}\r\n${block})\r\n`;
      });
      return `${out.join('')}${tag} OK FETCH completed\r\n`;
    }
    return `${tag} BAD unmodelled command\r\n`;
  };

  const connect = () => {
    const socket: any = new EventEmitter();
    socket.setTimeout = () => {};
    socket.end = () => setImmediate(() => socket.emit('close'));
    socket.destroy = () => setImmediate(() => socket.emit('close'));
    socket.write = (data: string) => {
      const reply = answer(data);
      if (reply) setImmediate(() => socket.emit('data', Buffer.from(reply)));
      return true;
    };
    setImmediate(() => socket.emit('data', Buffer.from('* OK IMAP4rev1 Service Ready\r\n')));
    return socket;
  };
  return { default: { connect }, connect };
});

vi.mock('../../lib/db', () => ({
  prisma: {
    senderAccount: { findUnique: vi.fn(), updateMany: vi.fn() },
    lead: { findMany: vi.fn(), findFirst: vi.fn() },
    inboundResponse: { findFirst: vi.fn(), createMany: vi.fn() },
    campaignEnrollment: { findMany: vi.fn(), updateMany: vi.fn() },
    emailDispatch: { findFirst: vi.fn() },
    $transaction: vi.fn(),
  },
}));

import { prisma } from '../../lib/db';
import { encryptSecret } from '../../lib/secrets';
import { countReplies } from '../../lib/engagementMetrics';
import { autoReplyKind, parseHeaderFields, referencedMessageIds, syncMailboxReplies } from '../../lib/imapService';

const mocked = prisma as any;

const MAILBOXES = [
  { id: 'mbx_sales', emailAddress: 'sales@arcreach.test', replyTo: null },
  // Sends with its Reply-To set to the sales mailbox, so its replies arrive there
  { id: 'mbx_team', emailAddress: 'team@arcreach.test', replyTo: 'Sales@ArcReach.test' },
  { id: 'mbx_other', emailAddress: 'other@arcreach.test', replyTo: null },
];
const CAMPAIGNS: Record<string, { name: string; stopOnReply: boolean }> = {
  'cmp-a': { name: 'Q3 Launch', stopOnReply: true },
  'cmp-b': { name: 'Webinar', stopOnReply: true },
  'cmp-c': { name: 'Newsletter', stopOnReply: false },
};
const LEADS = [{ id: 'lead-amy', email: 'amy@acme.test' }];

let mailboxRow: any;
let replies: any[];
let enrollments: any[];
let dispatches: any[];

const RELATIONS = {
  campaign: (row: any) => CAMPAIGNS[row.campaignId] ?? null,
  senderAccount: (row: any) => MAILBOXES.find((m) => m.id === row.senderAccountId) ?? null,
};

function dispatch(id: string, campaignId: string, senderAccountId: string, sentAt: string, status = 'Sent') {
  return { id, leadId: 'lead-amy', campaignId, senderAccountId, messageId: `op-${id}`, operationId: `op-${id}`, sentAt: new Date(sentAt), status };
}

function reply(uid: number, headers: string[], body = `body of ${uid}`) {
  return { uid, headers: ['From: Amy <amy@acme.test>', 'Date: Tue, 29 Sep 2026 10:00:00 +0000', `Message-ID: <amy-${uid}@acme.test>`, ...headers], body };
}

function enrollmentStatuses() {
  return Object.fromEntries(enrollments.map((e) => [e.campaignId, e.status]));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});

  server.messages = [];
  replies = [];
  dispatches = [];
  enrollments = Object.keys(CAMPAIGNS).map((campaignId) => ({ id: `enr-${campaignId}`, leadId: 'lead-amy', campaignId, status: 'Active' }));
  mailboxRow = {
    ...MAILBOXES[0],
    imapHost: 'imap.example.com',
    imapPort: 993,
    imapUser: 'sales@arcreach.test',
    imapPass: encryptSecret('secret'),
    imapAllowSelfSigned: false,
    imapUidValidity: 5,
    imapLastUid: 0,
  };

  mocked.senderAccount.findUnique.mockImplementation(async () => ({ ...mailboxRow }));
  mocked.senderAccount.updateMany.mockImplementation(async ({ where, data }: any) => {
    if (!matchesWhere(mailboxRow, where)) return { count: 0 };
    Object.assign(mailboxRow, data);
    return { count: 1 };
  });
  const leadsWhere = (where: any) => LEADS.filter((l) => where.email.in.map((e: string) => e.toLowerCase()).includes(l.email));
  mocked.lead.findMany.mockImplementation(async ({ where }: any) => leadsWhere(where));
  mocked.lead.findFirst.mockImplementation(async ({ where }: any) => leadsWhere(where)[0] ?? null);
  mocked.inboundResponse.findFirst.mockImplementation(async ({ where }: any) => replies.find((r) => matchesWhere(r, where)) ?? null);
  mocked.inboundResponse.createMany.mockImplementation(async ({ data }: any) => {
    if (replies.some((r) => r.senderAccountId === data.senderAccountId && r.messageId === data.messageId)) return { count: 0 };
    replies.push(data);
    return { count: 1 };
  });
  mocked.emailDispatch.findFirst.mockImplementation(async ({ where, orderBy }: any) => {
    expect(orderBy).toEqual({ sentAt: 'desc' });
    const found = dispatches
      .filter((d) => matchesWhere(d, where, RELATIONS))
      .sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime())[0];
    return found ? { campaignId: found.campaignId } : null;
  });
  mocked.campaignEnrollment.findMany.mockImplementation(async ({ where }: any) =>
    enrollments.filter((e) => matchesWhere(e, where, RELATIONS)).map((e) => ({ id: e.id, campaign: { name: CAMPAIGNS[e.campaignId].name } })),
  );
  mocked.campaignEnrollment.updateMany.mockImplementation(async ({ where, data }: any) => {
    const rows = enrollments.filter((e) => matchesWhere(e, where));
    rows.forEach((e) => Object.assign(e, data));
    return { count: rows.length };
  });
  // Rolls every write inside back when the callback throws, as Postgres does
  mocked.$transaction.mockImplementation(async (fn: any) => {
    const saved = { replies: replies.map((r) => ({ ...r })), enrollments: enrollments.map((e) => ({ ...e })) };
    try {
      return await fn(mocked);
    } catch (err) {
      replies = saved.replies;
      enrollments = saved.enrollments;
      throw err;
    }
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('automated mail never stops a sequence (M54)', () => {
  it('records an out-of-office reply flagged, leaving every sequence running, and a human reply after it pauses them', async () => {
    dispatches = [dispatch('a1', 'cmp-a', 'mbx_sales', '2026-09-28T09:00:00Z')];
    server.messages = [reply(1, ['Subject: Out of Office: Quick question', 'Auto-Submitted: auto-replied'])];

    expect(await syncMailboxReplies('mbx_sales')).toEqual({ success: true, syncedCount: 1 });
    expect(replies.map((r) => [r.messageId, r.campaignId, r.autoReply])).toEqual([['<amy-1@acme.test>', 'cmp-a', 'out-of-office']]);
    expect(enrollmentStatuses()).toEqual({ 'cmp-a': 'Active', 'cmp-b': 'Active', 'cmp-c': 'Active' });
    expect(mocked.campaignEnrollment.updateMany).not.toHaveBeenCalled();

    server.messages.push(reply(2, ['Subject: Re: Quick question'], 'Thanks, send me the deck.'));
    expect(await syncMailboxReplies('mbx_sales')).toEqual({ success: true, syncedCount: 1 });

    expect(replies.map((r) => [r.messageId, r.campaignId, r.autoReply])).toEqual([
      ['<amy-1@acme.test>', 'cmp-a', 'out-of-office'],
      ['<amy-2@acme.test>', 'cmp-a', null],
    ]);
    // The human reply paused the lead's stopOnReply sequences, in the transaction that recorded it
    expect(mocked.$transaction).toHaveBeenCalledTimes(2);
    expect(mocked.campaignEnrollment.updateMany).toHaveBeenCalledTimes(1);
    expect(enrollmentStatuses()).toEqual({ 'cmp-a': 'Paused', 'cmp-b': 'Paused', 'cmp-c': 'Active' });
  });

  it.each([
    ['X-Autoreply', ['Subject: Re: Quick question', 'X-Autoreply: yes'], 'auto-reply'],
    ['Precedence: bulk', ['Subject: Re: Quick question', 'Precedence: bulk'], 'auto-reply'],
    ['a delivery status report', ['Subject: Re: Quick question', 'Content-Type: multipart/report; report-type=delivery-status; boundary="b1"'], 'bounce'],
  ])('flags a reply marked by %s and pauses nothing', async (_label, headers, kind) => {
    server.messages = [reply(1, headers as string[], '--b1\r\nContent-Type: text/plain\r\n\r\nNot delivered\r\n--b1--\r\n')];

    expect(await syncMailboxReplies('mbx_sales')).toEqual({ success: true, syncedCount: 1 });

    expect(replies[0].autoReply).toBe(kind);
    expect(mocked.campaignEnrollment.findMany).not.toHaveBeenCalled();
    expect(enrollmentStatuses()).toEqual({ 'cmp-a': 'Active', 'cmp-b': 'Active', 'cmp-c': 'Active' });
  });

  it('leaves auto-replies out of the reply count', async () => {
    const rows = [
      { campaignId: 'cmp-a', autoReply: null },
      { campaignId: 'cmp-a', autoReply: 'out-of-office' },
      { campaignId: 'cmp-a', autoReply: 'bounce' },
      { campaignId: 'cmp-b', autoReply: null },
    ];
    const client: any = { inboundResponse: { count: async ({ where }: any) => rows.filter((r) => matchesWhere(r, where)).length } };

    expect(await countReplies(client, { kind: 'campaign', campaignId: 'cmp-a' })).toBe(1);
    expect(await countReplies(client, { kind: 'all' })).toBe(2);
  });
});

describe('a reply is attributed to the campaign it answers (M54)', () => {
  beforeEach(() => {
    dispatches = [
      dispatch('a1', 'cmp-a', 'mbx_sales', '2026-09-28T09:00:00Z'),
      dispatch('b1', 'cmp-b', 'mbx_sales', '2026-09-29T09:00:00Z'),
      // From another mailbox, which the reply didn't answer
      dispatch('c1', 'cmp-c', 'mbx_other', '2026-09-29T09:30:00Z'),
      // Never reached the lead
      dispatch('c2', 'cmp-c', 'mbx_sales', '2026-09-29T09:45:00Z', 'Failed'),
      // Sent after the reply
      dispatch('c3', 'cmp-c', 'mbx_sales', '2026-09-29T11:00:00Z'),
    ];
  });

  it('takes the campaign of the latest dispatch to the lead from the receiving mailbox sent before the reply', async () => {
    server.messages = [reply(1, ['Subject: Re: Webinar'])];

    expect(await syncMailboxReplies('mbx_sales')).toEqual({ success: true, syncedCount: 1 });
    expect(replies[0].campaignId).toBe('cmp-b');
  });

  it('counts dispatches from a mailbox whose Reply-To is the receiving mailbox', async () => {
    dispatches.push(dispatch('c4', 'cmp-c', 'mbx_team', '2026-09-29T09:50:00Z'));
    server.messages = [reply(1, ['Subject: Re: Newsletter'])];

    expect(await syncMailboxReplies('mbx_sales')).toEqual({ success: true, syncedCount: 1 });
    expect(replies[0].campaignId).toBe('cmp-c');
  });

  it('takes the campaign of the dispatch its In-Reply-To names over a later dispatch of another campaign', async () => {
    server.messages = [reply(1, ['Subject: Re: Q3 Launch', 'In-Reply-To: <op-a1>'])];

    expect(await syncMailboxReplies('mbx_sales')).toEqual({ success: true, syncedCount: 1 });
    expect(replies[0].campaignId).toBe('cmp-a');
  });

  it('takes the campaign of the earlier reply in its thread that References names', async () => {
    replies.push({ leadId: 'lead-amy', senderAccountId: 'mbx_sales', messageId: '<amy-0@acme.test>', campaignId: 'cmp-a', receivedAt: new Date('2026-09-28T12:00:00Z') });
    server.messages = [reply(1, ['Subject: Re: Q3 Launch', 'References: <acs-1@mail.test>', ' <amy-0@acme.test> <acs-2@mail.test>'])];

    expect(await syncMailboxReplies('mbx_sales')).toEqual({ success: true, syncedCount: 1 });
    expect(replies[1].campaignId).toBe('cmp-a');
  });

  it('leaves the campaign empty when nothing from the receiving mailbox reached the lead before the reply', async () => {
    dispatches = dispatches.filter((d) => d.senderAccountId !== 'mbx_sales' || d.status === 'Failed' || d.id === 'c3');
    server.messages = [reply(1, ['Subject: Re: Hello'])];

    expect(await syncMailboxReplies('mbx_sales')).toEqual({ success: true, syncedCount: 1 });
    expect(replies[0].campaignId).toBeNull();
  });
});

describe('a reply and its sequence pause are written together (L15)', () => {
  it('records neither when the pause fails, and both when the batch is read again', async () => {
    dispatches = [dispatch('a1', 'cmp-a', 'mbx_sales', '2026-09-28T09:00:00Z')];
    server.messages = [reply(1, ['Subject: Re: Quick question'])];
    mocked.campaignEnrollment.updateMany.mockRejectedValueOnce(new Error('database timeout'));

    const failed = await syncMailboxReplies('mbx_sales');

    expect(failed).toEqual({ success: false, error: 'database timeout' });
    expect(replies).toEqual([]);
    expect(enrollmentStatuses()).toEqual({ 'cmp-a': 'Active', 'cmp-b': 'Active', 'cmp-c': 'Active' });
    expect(mailboxRow.imapLastUid).toBe(0);

    expect(await syncMailboxReplies('mbx_sales')).toEqual({ success: true, syncedCount: 1 });
    expect(replies.map((r) => r.messageId)).toEqual(['<amy-1@acme.test>']);
    expect(enrollmentStatuses()).toEqual({ 'cmp-a': 'Paused', 'cmp-b': 'Paused', 'cmp-c': 'Active' });
    expect(mailboxRow.imapLastUid).toBe(1);
  });
});

describe('autoReplyKind', () => {
  const kind = (headers: string[], subject = 'Re: Quick question') => autoReplyKind(parseHeaderFields(headers.join('\r\n')), subject);

  it('reads the automated-mail headers', () => {
    expect(kind([])).toBeNull();
    expect(kind(['Auto-Submitted: auto-replied'])).toBe('auto-reply');
    expect(kind(['Auto-Submitted: auto-generated; owner-email="amy@acme.test"'])).toBe('auto-reply');
    expect(kind(['Auto-Submitted: no'])).toBeNull();
    expect(kind(['Auto-Submitted: No (sent by a person)'])).toBeNull();
    expect(kind(['X-Autoreply: yes'])).toBe('auto-reply');
    expect(kind(['X-Autorespond: Amy is away'])).toBe('auto-reply');
    expect(kind(['X-Autoreply: no'])).toBeNull();
    expect(kind(['Precedence: auto_reply'])).toBe('auto-reply');
    expect(kind(['Precedence: Junk'])).toBe('auto-reply');
    expect(kind(['Precedence: list'])).toBeNull();
    expect(kind(['Content-Type: multipart/report; report-type="delivery-status"; boundary=x'])).toBe('bounce');
    expect(kind(['Content-Type: multipart/report; report-type=disposition-notification; boundary=x'])).toBe('auto-reply');
    expect(kind(['Content-Type: multipart/alternative; boundary=x'])).toBeNull();
  });

  it('reads bounce, out-of-office and auto-reply subjects only at the start', () => {
    expect(kind([], 'Undeliverable: Quick question')).toBe('bounce');
    expect(kind([], 'Mail delivery failed: returning message to sender')).toBe('bounce');
    expect(kind([], 'Delivery Status Notification (Failure)')).toBe('bounce');
    expect(kind([], 'Out of Office: Quick question')).toBe('out-of-office');
    expect(kind([], ' OOO until Monday')).toBe('out-of-office');
    expect(kind([], 'Abwesenheitsnotiz: Quick question')).toBe('out-of-office');
    expect(kind(['Auto-Submitted: auto-replied'], 'Out of the office')).toBe('out-of-office');
    expect(kind([], 'Automatic reply: Quick question')).toBe('auto-reply');
    expect(kind([], 'Réponse automatique : Quick question')).toBe('auto-reply');
    expect(kind([], 'Auto Reply')).toBe('auto-reply');
    expect(kind([], 'Re: Out of office tools for your team')).toBeNull();
    expect(kind([], 'Re: Undeliverable packages')).toBeNull();
    expect(kind([], 'Oooh, interesting')).toBeNull();
  });
});

describe('referencedMessageIds', () => {
  it('lists In-Reply-To, then References newest first, bracketed and bare', () => {
    expect(referencedMessageIds('<b@x.test>', '<a@x.test> <b@x.test>')).toEqual(['<b@x.test>', 'b@x.test', '<a@x.test>', 'a@x.test']);
    expect(referencedMessageIds('', '')).toEqual([]);
    expect(referencedMessageIds('not an id', undefined)).toEqual([]);
  });

  it('hashes a long id as a recorded reply stores it and reads at most 20 ids', () => {
    const long = `<${'x'.repeat(300)}@x.test>`;
    expect(referencedMessageIds(long)).toEqual([expect.stringMatching(/^sha256 [0-9a-f]{64}$/)]);

    const many = Array.from({ length: 30 }, (_, i) => `<id${i}@x.test>`).join(' ');
    const ids = referencedMessageIds('', many);
    expect(ids).toHaveLength(40);
    expect(ids[0]).toBe('<id29@x.test>');
    expect(ids).not.toContain('<id9@x.test>');
  });
});
