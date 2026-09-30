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
  // UIDs whose text a body FETCH is refused (NO) for.
  refuseBody: new Set<number>(),
  // UIDs a header FETCH naming them is refused (NO) for. The server still sends the
  // headers of the other messages ('others', as Gmail does) or of those before the
  // first refused one ('before', as Dovecot does).
  refuseHeaders: new Set<number>(),
  headerRefusal: 'others' as 'others' | 'before',
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
      let uids = uidSet(rest[0]);
      if (!items.includes('HEADER.FIELDS') && uids.some((u) => server.refuseBody.has(u))) {
        return `${tag} NO [UNAVAILABLE] Message could not be read\r\n`;
      }
      const refused = items.includes('HEADER.FIELDS') ? uids.filter((u) => server.refuseHeaders.has(u)) : [];
      if (refused.length > 0) {
        const first = Math.min(...refused);
        uids = uids.filter((u) => !server.refuseHeaders.has(u) && (server.headerRefusal === 'others' || u < first));
      }
      const completion = refused.length > 0 ? 'NO Some messages could not be FETCHed (Failure)' : 'OK FETCH completed';
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
      return `${out}${tag} ${completion}\r\n`;
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

// Postgres refuses NUL in text, in a written value or a query parameter alike.
function rejectNul(value: unknown) {
  if (JSON.stringify(value).includes('\\u0000')) throw new Error('invalid byte sequence for encoding "UTF8": 0x00');
}

vi.mock('../../lib/db', () => {
  const prisma: any = {
    senderAccount: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    lead: { findMany: vi.fn(), findFirst: vi.fn() },
    inboundResponse: { findFirst: vi.fn(), createMany: vi.fn() },
    campaignEnrollment: { findMany: vi.fn(), updateMany: vi.fn() },
    emailDispatch: { findFirst: vi.fn() },
  };
  // A reply and its sequence pause are written in one transaction
  prisma.$transaction = vi.fn(async (fn: any) => fn(prisma));
  return { prisma };
});

import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/db';
import { encryptSecret } from '../../lib/secrets';
import {
  IMAP_MESSAGE_MAX_ATTEMPTS,
  IMAP_SYNC_BATCH_SIZE,
  checkpointAfterFailures,
  imapSearchDate,
  isTransientDbError,
  parseHeaderResponse,
  parseSearchUids,
  replySearchPlan,
  storableText,
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

/** The UIDs of each header FETCH of the latest sync, in the order sent. */
function headerFetches(): number[][] {
  return commands()
    .filter((c) => c.startsWith('UID FETCH') && c.includes('HEADER.FIELDS'))
    .map((c) => c.split(' ')[2].split(',').map(Number));
}

/** UIDs whose headers the latest sync fetched, or null when it fetched none. */
function headerFetchUids(): number[] | null {
  return headerFetches()[0] ?? null;
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
  vi.spyOn(console, 'warn').mockImplementation(() => {});

  server.seen = new Set();
  server.dropOn = null;
  server.refuseBody = new Set();
  server.refuseHeaders = new Set();
  server.headerRefusal = 'others';
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
    imapFailedUid: null,
    imapFailedUidAttempts: 0,
  };

  mocked.senderAccount.findUnique.mockImplementation(async () => ({ ...mailboxRow }));
  // The sync status (imapLastSyncAt, imapLastSyncError)
  mocked.senderAccount.update.mockImplementation(async ({ data }: any) => Object.assign(mailboxRow, data));
  mocked.senderAccount.updateMany.mockImplementation(async ({ where, data }: any) => {
    if (!matchesWhere(mailboxRow, where)) return { count: 0 };
    Object.assign(mailboxRow, data);
    return { count: 1 };
  });
  mocked.lead.findMany.mockImplementation(async ({ where }: any) => {
    rejectNul(where);
    return leadsWhere(where);
  });
  mocked.lead.findFirst.mockImplementation(async ({ where }: any) => {
    rejectNul(where);
    return leadsWhere(where)[0] ?? null;
  });
  mocked.inboundResponse.findFirst.mockImplementation(async ({ where }: any) => replies.find((r) => matchesWhere(r, where)) ?? null);
  // Unique by mailbox and Message-ID, like the table
  mocked.inboundResponse.createMany.mockImplementation(async ({ data }: any) => {
    rejectNul(data);
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
    expect(mailboxRow).toMatchObject({ imapLastUid: 10, imapFailedUid: 11, imapFailedUidAttempts: 1 });

    const retried = await sync();
    expect(retried).toEqual({ success: true, syncedCount: 1 });
    expect(commands()).toContain('UID SEARCH UID 11:*');
    expect(replies.map((r) => r.leadId)).toEqual(['lead-amy']);
    expect(mailboxRow).toMatchObject({ imapLastUid: 12, imapFailedUid: null, imapFailedUidAttempts: 0 });
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

describe('one bad message never stalls a mailbox reply sync (H32)', () => {
  beforeEach(() => {
    mailboxRow.imapUidValidity = VALIDITY;
    mailboxRow.imapLastUid = 10;
  });

  it('records a reply whose subject, body and sender hold NUL, without it', async () => {
    inbox([
      ...range(1, 10).map((uid) => msg(uid, 'news@vendor.test')),
      { ...msg(11, 'Amy <am\0y@acme.test>'), subject: 'Re: Hi\0 there', body: 'Thanks\0, sounds good' },
      msg(12, 'ben@acme.test'),
    ]);

    const result = await sync();

    expect(result).toEqual({ success: true, syncedCount: 2 });
    expect(replies.map((r) => [r.leadId, r.subject, r.body])).toEqual([
      ['lead-amy', 'Re: Hi there', 'Thanks, sounds good'],
      ['lead-ben', 'Message 12', 'body of 12'],
    ]);
    expect(mailboxRow).toMatchObject({ imapLastUid: 12, imapFailedUid: null, imapLastSyncError: null });
  });

  it('records a reply whose text the server refuses with an empty body, flagged, and reads on', async () => {
    inbox([...range(1, 10).map((uid) => msg(uid, 'news@vendor.test')), msg(11, 'amy@acme.test'), msg(12, 'ben@acme.test')]);
    server.refuseBody = new Set([11]);

    const result = await sync();

    expect(result).toEqual({ success: true, syncedCount: 2 });
    expect(replies.map((r) => [r.leadId, r.subject, r.body, r.bodyUnavailable])).toEqual([
      ['lead-amy', 'Message 11', '', true],
      ['lead-ben', 'Message 12', 'body of 12', false],
    ]);
    // Amy's reply still pauses her stopOnReply sequences
    expect(mocked.campaignEnrollment.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ leadId: 'lead-amy' }) }));
    expect(mailboxRow).toMatchObject({ imapLastUid: 12, imapFailedUid: null });
  });

  it('retries a message that fails to be recorded, records the replies after it, and skips it after too many syncs', async () => {
    inbox([
      ...range(1, 10).map((uid) => msg(uid, 'news@vendor.test')),
      msg(11, 'amy@acme.test'),
      msg(12, 'ben@acme.test'),
      msg(13, 'news@vendor.test'),
    ]);
    const write = mocked.inboundResponse.createMany.getMockImplementation();
    mocked.inboundResponse.createMany.mockImplementation(async (args: any) => {
      if (args.data.leadId === 'lead-amy') throw new Error('value too long for type character varying(255)');
      return write(args);
    });

    for (let attempt = 1; attempt < IMAP_MESSAGE_MAX_ATTEMPTS; attempt++) {
      const result = await sync();
      expect(result).toEqual({ success: false, error: 'value too long for type character varying(255)' });
      expect(commands()).toContain('UID SEARCH UID 11:*');
      // Ben's later reply is recorded at once, and only once
      expect(replies.map((r) => r.leadId)).toEqual(['lead-ben']);
      expect(mailboxRow).toMatchObject({ imapUidValidity: VALIDITY, imapLastUid: 10, imapFailedUid: 11, imapFailedUidAttempts: attempt });
      expect(mailboxRow.imapLastSyncError).toBe(
        `Could not record INBOX message UID 11 (attempt ${attempt} of ${IMAP_MESSAGE_MAX_ATTEMPTS} before it is skipped): value too long for type character varying(255).`
      );
    }

    const skipping = await sync();
    expect(skipping).toEqual({ success: true, syncedCount: 0 });
    expect(mailboxRow).toMatchObject({ imapLastUid: 13, imapFailedUid: null, imapFailedUidAttempts: 0 });
    expect(mailboxRow.imapLastSyncAt).toEqual(NOW);
    expect(mailboxRow.imapLastSyncError).toBe(
      `Skipped INBOX message UID 11 after ${IMAP_MESSAGE_MAX_ATTEMPTS} failed attempts to record it: value too long for type character varying(255).`
    );
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Skipped message UID 11 of sales@arcreach.test'));

    inbox([...server.messages, msg(14, 'cara@acme.test')]);
    const next = await sync();
    expect(next).toEqual({ success: true, syncedCount: 1 });
    expect(commands()).toContain('UID SEARCH UID 14:*');
    expect(replies.map((r) => r.leadId)).toEqual(['lead-ben', 'lead-cara']);
    expect(mailboxRow).toMatchObject({ imapLastUid: 14, imapLastSyncError: null });
  });

  const REFUSED = 'imap.example.com refused to send its headers (NO Some messages could not be FETCHed (Failure))';

  it('records the replies around a message whose headers the server refuses, sending the others, and skips it after too many syncs', async () => {
    // UID 12 is not even a lead's message: headers are fetched for every message of the batch.
    inbox([
      ...range(1, 10).map((uid) => msg(uid, 'news@vendor.test')),
      msg(11, 'amy@acme.test'),
      msg(12, 'news@vendor.test'),
      msg(13, 'ben@acme.test'),
    ]);
    server.refuseHeaders = new Set([12]);

    for (let attempt = 1; attempt < IMAP_MESSAGE_MAX_ATTEMPTS; attempt++) {
      const result = await sync();
      expect(result).toEqual({ success: false, error: REFUSED });
      // The refused message is fetched again alone
      expect(headerFetches()).toEqual(attempt === 1 ? [[11, 12, 13], [12]] : [[12, 13], [12]]);
      expect(replies.map((r) => r.leadId)).toEqual(['lead-amy', 'lead-ben']);
      expect(mailboxRow).toMatchObject({ imapLastUid: 11, imapFailedUid: 12, imapFailedUidAttempts: attempt });
      expect(mailboxRow.imapLastSyncError).toBe(
        `Could not record INBOX message UID 12 (attempt ${attempt} of ${IMAP_MESSAGE_MAX_ATTEMPTS} before it is skipped): ${REFUSED}.`
      );
    }

    const skipping = await sync();
    expect(skipping).toEqual({ success: true, syncedCount: 0 });
    expect(mailboxRow).toMatchObject({ imapLastUid: 13, imapFailedUid: null, imapFailedUidAttempts: 0 });
    expect(mailboxRow.imapLastSyncError).toBe(`Skipped INBOX message UID 12 after ${IMAP_MESSAGE_MAX_ATTEMPTS} failed attempts to record it: ${REFUSED}.`);

    inbox([...server.messages, msg(14, 'cara@acme.test')]);
    const next = await sync();
    expect(next).toEqual({ success: true, syncedCount: 1 });
    expect(headerFetches()).toEqual([[14]]);
    expect(replies.map((r) => r.leadId)).toEqual(['lead-amy', 'lead-ben', 'lead-cara']);
    expect(mailboxRow).toMatchObject({ imapLastUid: 14, imapLastSyncError: null });
  });

  it('isolates a message whose headers the server refuses after sending only those before it', async () => {
    server.headerRefusal = 'before';
    inbox([
      ...range(1, 10).map((uid) => msg(uid, 'news@vendor.test')),
      msg(11, 'amy@acme.test'),
      msg(12, 'news@vendor.test'),
      msg(13, 'ben@acme.test'),
      msg(14, 'news@vendor.test'),
    ]);
    server.refuseHeaders = new Set([12]);

    for (let attempt = 1; attempt < IMAP_MESSAGE_MAX_ATTEMPTS; attempt++) {
      const result = await sync();
      expect(result).toEqual({ success: false, error: REFUSED });
      // Held just before it, the refused message leads the batch, and the server sends
      // nothing of that FETCH: it is fetched alone and the rest together.
      expect(headerFetches()).toEqual(attempt === 1 ? [[11, 12, 13, 14], [12], [13, 14]] : [[12, 13, 14], [12], [13, 14]]);
      expect(replies.map((r) => r.leadId)).toEqual(['lead-amy', 'lead-ben']);
      expect(mailboxRow).toMatchObject({ imapLastUid: 11, imapFailedUid: 12, imapFailedUidAttempts: attempt });
    }

    const skipping = await sync();
    expect(skipping).toEqual({ success: true, syncedCount: 0 });
    expect(mailboxRow).toMatchObject({ imapLastUid: 14, imapFailedUid: null, imapFailedUidAttempts: 0 });
  });

  it('fails the sync without counting any message when the server sends no header of the batch', async () => {
    inbox([...range(1, 10).map((uid) => msg(uid, 'news@vendor.test')), msg(11, 'amy@acme.test'), msg(12, 'ben@acme.test'), msg(13, 'news@vendor.test')]);
    // Every message refused: a session-wide refusal, such as a bandwidth limit
    server.refuseHeaders = new Set([11, 12, 13]);

    for (let i = 0; i <= IMAP_MESSAGE_MAX_ATTEMPTS; i++) {
      const result = await sync();
      expect(result).toEqual({ success: false, error: 'IMAP Fetch headers failed: NO Some messages could not be FETCHed (Failure)' });
      expect(headerFetches()).toEqual([[11, 12, 13], [11], [12, 13]]);
    }
    expect(mocked.senderAccount.updateMany).not.toHaveBeenCalled();
    expect(mailboxRow).toMatchObject({ imapLastUid: 10, imapFailedUid: null, imapFailedUidAttempts: 0 });
    expect(mailboxRow.imapLastSyncError).toBe('Sync failed: IMAP Fetch headers failed: NO Some messages could not be FETCHed (Failure)');

    // One refused message alone in its batch is not counted either, until another shows the server works
    server.refuseHeaders = new Set([11]);
    inbox(server.messages.filter((m) => m.uid <= 11));
    expect(await sync()).toEqual({ success: false, error: 'IMAP Fetch headers failed: NO Some messages could not be FETCHed (Failure)' });
    expect(headerFetches()).toEqual([[11]]);
    expect(mailboxRow).toMatchObject({ imapLastUid: 10, imapFailedUid: null });

    inbox([...server.messages, msg(12, 'ben@acme.test')]);
    expect(await sync()).toEqual({ success: false, error: REFUSED });
    expect(replies.map((r) => r.leadId)).toEqual(['lead-ben']);
    expect(mailboxRow).toMatchObject({ imapLastUid: 10, imapFailedUid: 11, imapFailedUidAttempts: 1 });
  });

  it('never skips a message that fails only on temporary database errors', async () => {
    inbox([...range(1, 10).map((uid) => msg(uid, 'news@vendor.test')), msg(11, 'amy@acme.test'), msg(12, 'ben@acme.test')]);
    const write = mocked.inboundResponse.createMany.getMockImplementation();
    let poolBusy = true;
    mocked.inboundResponse.createMany.mockImplementation(async (args: any) => {
      if (poolBusy && args.data.leadId === 'lead-amy') {
        throw new Prisma.PrismaClientKnownRequestError('Timed out fetching a new connection from the connection pool.', { code: 'P2024', clientVersion: 'test' });
      }
      return write(args);
    });

    for (let i = 0; i < 2 * IMAP_MESSAGE_MAX_ATTEMPTS; i++) {
      const result = await sync();
      expect(result.success).toBe(false);
      expect(replies.map((r) => r.leadId)).toEqual(['lead-ben']);
      expect(mailboxRow).toMatchObject({ imapLastUid: 10, imapFailedUid: 11, imapFailedUidAttempts: 0 });
    }
    expect(mailboxRow.imapLastSyncError).toBe(
      'Could not record INBOX message UID 11 because of a temporary database error, retried without counting toward skipping it: ' +
      'Timed out fetching a new connection from the connection pool.'
    );

    poolBusy = false;
    expect(await sync()).toEqual({ success: true, syncedCount: 1 });
    expect(replies.map((r) => r.leadId)).toEqual(['lead-ben', 'lead-amy']);
    expect(mailboxRow).toMatchObject({ imapLastUid: 12, imapFailedUid: null, imapLastSyncError: null });
  });

  it('starts over from the lookback window when the checkpoint is at or past the INBOX UIDNEXT', async () => {
    mailboxRow.imapLastUid = 5000;
    inbox([msg(1, 'amy@acme.test', 30), msg(2, 'ben@acme.test'), msg(3, 'news@vendor.test')]);

    const result = await sync();

    expect(result).toEqual({ success: true, syncedCount: 1 });
    expect(commands()).toContain('UID SEARCH SINCE 23-Sep-2026');
    expect(replies.map((r) => r.leadId)).toEqual(['lead-ben']);
    expect(mailboxRow).toMatchObject({ imapUidValidity: VALIDITY, imapLastUid: 3 });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('(UID 5000) is at or past the INBOX UIDNEXT 4'));
  });

  it('does not write its checkpoint back after the IMAP host or login changed during the sync', async () => {
    for (const change of [{ imapHost: 'imap.new.test' }, { imapUser: 'other@arcreach.test' }]) {
      mailboxRow = { ...mailboxRow, imapHost: 'imap.example.com', imapUser: 'sales@arcreach.test', imapUidValidity: VALIDITY, imapLastUid: 10 };
      inbox([...range(1, 10).map((uid) => msg(uid, 'news@vendor.test')), msg(11, 'amy@acme.test')]);
      // PUT /api/accounts saves the change and resets the checkpoint while the batch is read
      mocked.lead.findMany.mockImplementationOnce(async ({ where }: any) => {
        Object.assign(mailboxRow, change, { imapUidValidity: null, imapLastUid: null, imapFailedUid: null, imapFailedUidAttempts: 0 });
        return leadsWhere(where);
      });

      await sync();

      expect(mailboxRow).toMatchObject({ ...change, imapUidValidity: null, imapLastUid: null });
    }
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

  it('resumes only below the INBOX UIDNEXT when the server sends one', () => {
    const checkpoint = { imapUidValidity: VALIDITY, imapLastUid: 41 };
    expect(replySearchPlan(checkpoint, VALIDITY, NOW, 42)).toEqual({ cmd: 'UID SEARCH UID 42:*', afterUid: 41, resumed: true });
    expect(replySearchPlan(checkpoint, VALIDITY, NOW, null)).toEqual({ cmd: 'UID SEARCH UID 42:*', afterUid: 41, resumed: true });
    for (const uidNext of [41, 5]) {
      expect(replySearchPlan(checkpoint, VALIDITY, NOW, uidNext)).toEqual({ cmd: 'UID SEARCH SINCE 23-Sep-2026', afterUid: 0, resumed: false });
    }
  });

  it('holds the checkpoint before the first failed message and skips one that failed too many syncs in a row', () => {
    const none = { uid: null, attempts: 0 };
    expect(checkpointAfterFailures(30, [], none)).toEqual({ lastUid: 30, failedUid: null, attempts: 0, skipped: [] });
    expect(checkpointAfterFailures(30, [12, 20], none)).toEqual({ lastUid: 11, failedUid: 12, attempts: 1, skipped: [] });
    expect(checkpointAfterFailures(30, [12, 20], { uid: 12, attempts: 2 })).toEqual({ lastUid: 11, failedUid: 12, attempts: 3, skipped: [] });
    // Another message than the one counted starts again at 1
    expect(checkpointAfterFailures(30, [20], { uid: 12, attempts: IMAP_MESSAGE_MAX_ATTEMPTS - 1 })).toEqual({ lastUid: 19, failedUid: 20, attempts: 1, skipped: [] });
    const last = { uid: 12, attempts: IMAP_MESSAGE_MAX_ATTEMPTS - 1 };
    expect(checkpointAfterFailures(30, [12, 20], last)).toEqual({ lastUid: 19, failedUid: 20, attempts: 1, skipped: [12] });
    expect(checkpointAfterFailures(30, [12], last)).toEqual({ lastUid: 30, failedUid: null, attempts: 0, skipped: [12] });
    // An uncounted failure holds the checkpoint with the attempts it had
    expect(checkpointAfterFailures(30, [12, 20], last, new Set([12]))).toEqual({ lastUid: 11, failedUid: 12, attempts: IMAP_MESSAGE_MAX_ATTEMPTS - 1, skipped: [] });
    expect(checkpointAfterFailures(30, [12], none, new Set([12]))).toEqual({ lastUid: 11, failedUid: 12, attempts: 0, skipped: [] });
  });

  it('tells temporary database errors from ones about the message', () => {
    const known = (code: string) => new Prisma.PrismaClientKnownRequestError('failed', { code, clientVersion: 'test' });
    for (const code of ['P2024', 'P2028', 'P2034', 'P1017']) expect(isTransientDbError(known(code))).toBe(true);
    expect(isTransientDbError(new Prisma.PrismaClientInitializationError("Can't reach database server", 'test', 'P1001'))).toBe(true);
    for (const err of [known('P2000'), known('P2002'), new Error('invalid byte sequence for encoding "UTF8": 0x00'), Object.assign(new Error('reset'), { code: 'ECONNRESET' }), null]) {
      expect(isTransientDbError(err)).toBe(false);
    }
  });

  it('removes NUL and replaces unpaired surrogates, keeping every other character', () => {
    expect(storableText('Hi\0 there\0')).toBe('Hi there');
    expect(storableText('Jürgen 😀 \t\x01')).toBe('Jürgen 😀 \t\x01');
    expect(storableText('cut \uD83D')).toBe('cut \uFFFD');
    expect(storableText('\uDE00 alone')).toBe('\uFFFD alone');
  });

  it('formats SEARCH dates as d-Mon-yyyy in UTC and reads SEARCH results', () => {
    expect(imapSearchDate(new Date('2026-09-03T23:30:00Z'))).toBe('3-Sep-2026');
    expect(imapSearchDate(new Date('2026-12-31T00:00:00Z'))).toBe('31-Dec-2026');
    expect(parseSearchUids('* SEARCH 4 5 4294967295\r\nA3 OK SEARCH completed\r\n')).toEqual([4, 5, 4294967295]);
    expect(parseSearchUids('* SEARCH\r\nA3 OK SEARCH completed\r\n')).toEqual([]);
  });
});
