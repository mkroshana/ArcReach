import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { matchesWhere } from './helpers/prismaWhere';

// Fake IMAP server holding one INBOX. It answers the commands the sync sends as an
// RFC 3501 server does, including "UID n:*" listing the newest message when n is
// past it, and sets \Seen on every message fetched with BODY[...] instead of BODY.PEEK[...].
const server = vi.hoisted(() => ({
  uidValidity: 0,
  uidNext: 1,
  messages: [] as { uid: number; from: string; subject: string; internalDate: Date; body: string }[],
  seen: new Set<number>(),
  written: [] as string[],
  // Close the connection instead of answering a matching command.
  dropOn: null as RegExp | null,
}));

vi.mock('tls', () => {
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const sorted = () => [...server.messages].sort((a, b) => a.uid - b.uid);
  const maxUid = () => Math.max(0, ...server.messages.map((m) => m.uid));
  const uidSet = (set: string): number[] => {
    const uids = new Set<number>();
    for (const part of set.split(',')) {
      const [a, b = a] = part.split(':').map((x) => (x === '*' ? maxUid() : Number(x)));
      for (const m of server.messages) if (m.uid >= Math.min(a, b) && m.uid <= Math.max(a, b)) uids.add(m.uid);
    }
    return [...uids];
  };

  const answer = (cmd: string): string => {
    const [tag, verb, sub, ...rest] = cmd.trim().split(' ');
    if (verb === 'LOGIN') return `${tag} OK LOGIN completed\r\n`;
    if (verb === 'LOGOUT') return '';
    if (verb === 'EXAMINE' || verb === 'SELECT') {
      return `* ${server.messages.length} EXISTS\r\n* OK [UIDVALIDITY ${server.uidValidity}] UIDs valid\r\n` +
        `* OK [UIDNEXT ${server.uidNext}] Predicted next UID\r\n${tag} OK ${verb} completed\r\n`;
    }
    if (verb === 'UID' && sub === 'SEARCH') {
      let uids: number[] = [];
      if (rest[0] === 'UID') {
        uids = uidSet(rest[1]);
      } else if (rest[0] === 'SINCE') {
        const [d, mon, y] = rest[1].split('-');
        const since = Date.UTC(Number(y), MONTHS.indexOf(mon), Number(d));
        uids = server.messages.filter((m) => m.internalDate.getTime() >= since).map((m) => m.uid);
      } else {
        return `${tag} BAD unmodelled search\r\n`;
      }
      return `* SEARCH${uids.map((u) => ` ${u}`).join('')}\r\n${tag} OK SEARCH completed\r\n`;
    }
    if (verb === 'UID' && sub === 'FETCH') {
      const items = rest.slice(1).join(' ');
      const uids = uidSet(rest[0]);
      if (/BODY\[/.test(items)) uids.forEach((u) => server.seen.add(u));
      let out = '';
      sorted().forEach((m, i) => {
        if (!uids.includes(m.uid)) return;
        if (items.includes('HEADER.FIELDS')) {
          const hdr = `From: ${m.from}\r\nSubject: ${m.subject}\r\nDate: ${m.internalDate.toUTCString()}\r\n\r\n`;
          out += `* ${i + 1} FETCH (UID ${m.uid} BODY[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID IN-REPLY-TO REFERENCES)] {${Buffer.byteLength(hdr)}}\r\n${hdr})\r\n`;
        } else {
          out += `* ${i + 1} FETCH (UID ${m.uid} BODY[TEXT] {${Buffer.byteLength(m.body)}}\r\n${m.body})\r\n`;
        }
      });
      return `${out}${tag} OK FETCH completed\r\n`;
    }
    return `${tag} BAD unmodelled command\r\n`;
  };

  const connect = () => {
    const socket: any = new EventEmitter();
    socket.setTimeout = () => {};
    socket.end = () => setImmediate(() => socket.emit('close'));
    socket.destroy = () => setImmediate(() => socket.emit('close'));
    socket.write = (data: string) => {
      server.written.push(data);
      if (server.dropOn?.test(data)) {
        setImmediate(() => socket.emit('close'));
        return true;
      }
      const reply = answer(data);
      if (reply) setImmediate(() => socket.emit('data', Buffer.from(reply)));
      return true;
    };
    setImmediate(() => socket.emit('data', Buffer.from('* OK IMAP4rev1 Service Ready\r\n')));
    return socket;
  };
  return { default: { connect }, connect };
});

vi.mock('../../lib/db', () => {
  const prisma: any = {
    senderAccount: { findUnique: vi.fn(), updateMany: vi.fn() },
    lead: { findMany: vi.fn(), findFirst: vi.fn() },
    inboundResponse: { findFirst: vi.fn(), createMany: vi.fn() },
    campaignEnrollment: { findMany: vi.fn(), updateMany: vi.fn() },
    emailDispatch: { findFirst: vi.fn() },
  };
  // A reply and its sequence pause are written in one transaction
  prisma.$transaction = vi.fn(async (fn: any) => fn(prisma));
  return { prisma };
});

import { prisma } from '../../lib/db';
import { encryptSecret } from '../../lib/secrets';
import {
  IMAP_SYNC_BATCH_SIZE,
  imapSearchDate,
  parseHeaderResponse,
  parseSearchUids,
  replySearchPlan,
  syncMailboxReplies,
} from '../../lib/imapService';

const mocked = prisma as any;

const NOW = new Date('2026-09-30T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const VALIDITY = 1700000000;

const LEADS = [
  { id: 'lead-amy', email: 'amy@acme.test' },
  { id: 'lead-ben', email: 'ben@acme.test' },
  { id: 'lead-cara', email: 'cara@acme.test' },
  { id: 'lead-dan', email: 'dan@acme.test' },
];

let mailboxRow: any;
let replies: any[];

function leadsWhere(where: any) {
  const wanted = where.email.in.map((e: string) => e.toLowerCase());
  return LEADS.filter((l) => wanted.includes(l.email.toLowerCase()));
}

/** A message `daysAgo` days old; UIDs are minutes apart so each lead's replies stay distinct. */
function msg(uid: number, from: string, daysAgo = 1) {
  return {
    uid,
    from,
    subject: `Message ${uid}`,
    internalDate: new Date(NOW.getTime() - daysAgo * DAY + uid * 60_000),
    body: `body of ${uid}`,
  };
}

function inbox(messages: ReturnType<typeof msg>[], uidValidity = VALIDITY) {
  server.messages = messages;
  server.uidValidity = uidValidity;
  server.uidNext = Math.max(0, ...messages.map((m) => m.uid)) + 1;
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

/** Commands of the latest sync, without their tags. */
function commands(): string[] {
  return server.written.map((w) => w.trim().split(' ').slice(1).join(' '));
}

/** UIDs whose headers the latest sync fetched, or null when it fetched none. */
function headerFetchUids(): number[] | null {
  const cmd = commands().find((c) => c.startsWith('UID FETCH') && c.includes('HEADER.FIELDS'));
  return cmd ? cmd.split(' ')[2].split(',').map(Number) : null;
}

async function sync() {
  server.written = [];
  return syncMailboxReplies('mbx_1');
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});

  server.seen = new Set();
  server.dropOn = null;
  replies = [];
  mailboxRow = {
    id: 'mbx_1',
    emailAddress: 'sales@arcreach.test',
    imapHost: 'imap.example.com',
    imapPort: 993,
    imapUser: 'sales@arcreach.test',
    imapPass: encryptSecret('secret'),
    imapAllowSelfSigned: false,
    imapUidValidity: null,
    imapLastUid: null,
  };

  mocked.senderAccount.findUnique.mockImplementation(async () => ({ ...mailboxRow }));
  mocked.senderAccount.updateMany.mockImplementation(async ({ where, data }: any) => {
    if (!matchesWhere(mailboxRow, where)) return { count: 0 };
    Object.assign(mailboxRow, data);
    return { count: 1 };
  });
  mocked.lead.findMany.mockImplementation(async ({ where }: any) => leadsWhere(where));
  mocked.lead.findFirst.mockImplementation(async ({ where }: any) => leadsWhere(where)[0] ?? null);
  mocked.inboundResponse.findFirst.mockImplementation(async ({ where }: any) => replies.find((r) => matchesWhere(r, where)) ?? null);
  // Unique by mailbox and Message-ID, like the table
  mocked.inboundResponse.createMany.mockImplementation(async ({ data }: any) => {
    if (replies.some((r) => r.senderAccountId === data.senderAccountId && r.messageId === data.messageId)) return { count: 0 };
    replies.push(data);
    return { count: 1 };
  });
  mocked.campaignEnrollment.findMany.mockResolvedValue([]);
  mocked.emailDispatch.findFirst.mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('IMAP reply sync checkpoint (H32)', () => {
  it('reads every message after the checkpoint, oldest first, in bounded batches', async () => {
    mailboxRow.imapUidValidity = VALIDITY;
    mailboxRow.imapLastUid = 100;
    // 250 messages arrived while the worker was down; the oldest one is a lead's reply.
    const from = (uid: number) =>
      ({ 50: 'dan@acme.test', 101: 'Amy <amy@acme.test>', 300: 'ben@acme.test', 350: 'Cara <CARA@acme.test>' } as Record<number, string>)[uid]
        ?? `news${uid}@vendor.test`;
    inbox(range(1, 350).map((uid) => msg(uid, from(uid))));

    const first = await sync();
    expect(first).toEqual({ success: true, syncedCount: 2 });
    expect(commands()).toContain('UID SEARCH UID 101:*');
    expect(headerFetchUids()).toEqual(range(101, 100 + IMAP_SYNC_BATCH_SIZE));
    expect(replies.map((r) => r.leadId)).toEqual(['lead-amy', 'lead-ben']);
    expect(mailboxRow).toMatchObject({ imapUidValidity: VALIDITY, imapLastUid: 300 });

    const second = await sync();
    expect(second).toEqual({ success: true, syncedCount: 1 });
    expect(commands()).toContain('UID SEARCH UID 301:*');
    expect(headerFetchUids()).toEqual(range(301, 350));
    expect(replies.map((r) => r.leadId)).toEqual(['lead-amy', 'lead-ben', 'lead-cara']);
    expect(mailboxRow.imapLastUid).toBe(350);

    // Caught up: the server still lists UID 350 for "351:*", which is not read again.
    mocked.senderAccount.updateMany.mockClear();
    const third = await sync();
    expect(third).toEqual({ success: true, syncedCount: 0 });
    expect(commands()).toContain('UID SEARCH UID 351:*');
    expect(headerFetchUids()).toBeNull();
    expect(mocked.senderAccount.updateMany).not.toHaveBeenCalled();
    // Dan's message was read before the checkpoint was saved and is never picked up.
    expect(replies.some((r) => r.leadId === 'lead-dan')).toBe(false);
  });

  it('starts a mailbox without a checkpoint at the last 7 days and saves UIDVALIDITY with the last UID', async () => {
    inbox([msg(1, 'amy@acme.test', 30), msg(2, 'Ben <ben@acme.test>'), msg(3, 'news@vendor.test')]);

    const result = await sync();

    expect(result).toEqual({ success: true, syncedCount: 1 });
    expect(commands()).toContain('UID SEARCH SINCE 23-Sep-2026');
    expect(headerFetchUids()).toEqual([2, 3]);
    // Ben's reply is the first message of the FETCH response (M56).
    expect(replies.map((r) => r.leadId)).toEqual(['lead-ben']);
    expect(mailboxRow).toMatchObject({ imapUidValidity: VALIDITY, imapLastUid: 3 });
  });

  it('starts over from the lookback window when the server reports a new UIDVALIDITY', async () => {
    mailboxRow.imapUidValidity = 111;
    mailboxRow.imapLastUid = 5000;
    inbox([msg(1, 'amy@acme.test'), msg(2, 'news@vendor.test')], 222);

    const result = await sync();

    expect(result).toEqual({ success: true, syncedCount: 1 });
    expect(commands()).toContain('UID SEARCH SINCE 23-Sep-2026');
    expect(replies.map((r) => r.leadId)).toEqual(['lead-amy']);
    expect(mailboxRow).toMatchObject({ imapUidValidity: 222, imapLastUid: 2 });
  });

  it('starts the checkpoint at the newest message when nothing is new, then reads what arrives next', async () => {
    inbox([msg(1, 'amy@acme.test', 30), msg(2, 'news@vendor.test', 30)]);

    await sync();
    expect(headerFetchUids()).toBeNull();
    expect(mailboxRow).toMatchObject({ imapUidValidity: VALIDITY, imapLastUid: 2 });

    inbox([...server.messages, msg(3, 'ben@acme.test')]);
    const next = await sync();
    expect(next).toEqual({ success: true, syncedCount: 1 });
    expect(commands()).toContain('UID SEARCH UID 3:*');
    expect(replies.map((r) => r.leadId)).toEqual(['lead-ben']);
    expect(mailboxRow.imapLastUid).toBe(3);
  });

  it('does not search an empty INBOX', async () => {
    inbox([]);

    const result = await sync();

    expect(result).toEqual({ success: true, syncedCount: 0 });
    expect(commands().some((c) => c.startsWith('UID SEARCH'))).toBe(false);
    expect(mailboxRow).toMatchObject({ imapUidValidity: VALIDITY, imapLastUid: 0 });
  });

  it('keeps the checkpoint when a reply fails to save, and reads the batch again', async () => {
    mailboxRow.imapUidValidity = VALIDITY;
    mailboxRow.imapLastUid = 10;
    inbox([...range(1, 10).map((uid) => msg(uid, 'news@vendor.test')), msg(11, 'amy@acme.test'), msg(12, 'news@vendor.test')]);
    mocked.inboundResponse.createMany.mockRejectedValueOnce(new Error('database unavailable'));

    const failed = await sync();
    expect(failed.success).toBe(false);
    expect(mocked.senderAccount.updateMany).not.toHaveBeenCalled();
    expect(mailboxRow.imapLastUid).toBe(10);

    const retried = await sync();
    expect(retried).toEqual({ success: true, syncedCount: 1 });
    expect(commands()).toContain('UID SEARCH UID 11:*');
    expect(replies.map((r) => r.leadId)).toEqual(['lead-amy']);
    expect(mailboxRow.imapLastUid).toBe(12);
  });

  it('keeps the checkpoint when the connection drops before the batch is fetched', async () => {
    mailboxRow.imapUidValidity = VALIDITY;
    mailboxRow.imapLastUid = 10;
    inbox([...range(1, 10).map((uid) => msg(uid, 'news@vendor.test')), msg(11, 'amy@acme.test')]);
    server.dropOn = /BODY\.PEEK\[TEXT\]/;

    await sync();
    expect(replies).toEqual([]);
    expect(mocked.senderAccount.updateMany).not.toHaveBeenCalled();
    expect(mailboxRow.imapLastUid).toBe(10);

    server.dropOn = null;
    const next = await sync();
    expect(next).toEqual({ success: true, syncedCount: 1 });
    expect(mailboxRow.imapLastUid).toBe(11);
  });

  it('never moves the checkpoint back when an older batch finishes last', async () => {
    mailboxRow.imapUidValidity = VALIDITY;
    mailboxRow.imapLastUid = 400;
    // A concurrent sync that started from UID 300 finishes after this one saved 400.
    inbox(range(1, 320).map((uid) => msg(uid, 'news@vendor.test')));
    mocked.senderAccount.findUnique.mockImplementationOnce(async () => ({ ...mailboxRow, imapLastUid: 300 }));

    await sync();

    expect(headerFetchUids()).toEqual(range(301, 320));
    expect(mailboxRow.imapLastUid).toBe(400);
  });
});

describe('IMAP sync leaves mail unread (M53)', () => {
  it('opens the INBOX read-only and fetches headers and bodies with BODY.PEEK', async () => {
    inbox([msg(1, 'amy@acme.test'), msg(2, 'news@vendor.test'), msg(3, 'ben@acme.test')]);

    const result = await sync();

    expect(result).toEqual({ success: true, syncedCount: 2 });
    expect(commands()).toContain('EXAMINE INBOX');
    expect(commands().some((c) => c.startsWith('SELECT'))).toBe(false);
    const fetches = commands().filter((c) => c.startsWith('UID FETCH'));
    expect(fetches).toHaveLength(3);
    for (const f of fetches) {
      expect(f).toContain('BODY.PEEK[');
      expect(f).not.toMatch(/BODY\[/);
    }
    expect([...server.seen]).toEqual([]);
  });
});

describe('parseHeaderResponse (M56)', () => {
  it('returns every message of a multi-message FETCH response, the first one included', () => {
    const literal = (lines: string[]) => {
      const text = lines.join('\r\n');
      return `{${Buffer.byteLength(text)}}\r\n${text}`;
    };
    const resp = [
      `* 1 FETCH (UID 41 BODY[HEADER.FIELDS (FROM SUBJECT DATE)] ${literal([
        'From: Amy <amy@acme.test>',
        'Subject: Re: Hello',
        'Date: Tue, 29 Sep 2026 10:00:00 +0000',
        '',
        '',
      ])})`,
      // Some servers send the UID after the header literal.
      `* 2 FETCH (BODY[HEADER.FIELDS (FROM SUBJECT DATE)] ${literal([
        'From: ben@acme.test',
        'Subject: Re: Hi',
        'Date: Tue, 29 Sep 2026 11:00:00 +0000',
        '',
        '',
      ])} UID 42)`,
      // An unsolicited flag update has no UID and is skipped.
      '* 3 FETCH (FLAGS (\\Seen))',
      'A4 OK FETCH completed',
      '',
    ].join('\r\n');

    const parsed = parseHeaderResponse(resp);

    expect(parsed.map((h) => [h.uid, h.from, h.subject])).toEqual([
      [41, 'amy@acme.test', 'Re: Hello'],
      [42, 'ben@acme.test', 'Re: Hi'],
    ]);
    expect(parsed[0].date.toISOString()).toBe('2026-09-29T10:00:00.000Z');
  });
});

describe('reply search helpers', () => {
  it('resumes after the saved UID only under the same UIDVALIDITY', () => {
    expect(replySearchPlan({ imapUidValidity: VALIDITY, imapLastUid: 41 }, VALIDITY, NOW))
      .toEqual({ cmd: 'UID SEARCH UID 42:*', afterUid: 41, resumed: true });
    for (const checkpoint of [
      { imapUidValidity: null, imapLastUid: null },
      { imapUidValidity: 111, imapLastUid: 41 },
      { imapUidValidity: VALIDITY, imapLastUid: null },
    ]) {
      expect(replySearchPlan(checkpoint, VALIDITY, NOW)).toEqual({ cmd: 'UID SEARCH SINCE 23-Sep-2026', afterUid: 0, resumed: false });
    }
  });

  it('formats SEARCH dates as d-Mon-yyyy in UTC and reads SEARCH results', () => {
    expect(imapSearchDate(new Date('2026-09-03T23:30:00Z'))).toBe('3-Sep-2026');
    expect(imapSearchDate(new Date('2026-12-31T00:00:00Z'))).toBe('31-Dec-2026');
    expect(parseSearchUids('* SEARCH 4 5 4294967295\r\nA3 OK SEARCH completed\r\n')).toEqual([4, 5, 4294967295]);
    expect(parseSearchUids('* SEARCH\r\nA3 OK SEARCH completed\r\n')).toEqual([]);
  });
});
