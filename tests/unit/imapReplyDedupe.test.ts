import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { matchesWhere } from './helpers/prismaWhere';

// Fake IMAP server holding one INBOX of messages with raw header lines. It sends
// INTERNALDATE only when the FETCH asks for it, and holds its LOGIN answer while
// `gate` is pending so a sync can be kept in progress.
const server = vi.hoisted(() => ({
  uidValidity: 0,
  messages: [] as { uid: number; headers: string[]; internalDate?: string; body: string }[],
  written: [] as string[],
  gate: null as Promise<void> | null,
}));

vi.mock('tls', () => {
  const answer = (data: string): string => {
    const [tag, verb, sub, ...rest] = data.trim().split(' ');
    if (verb === 'LOGIN') return `${tag} OK LOGIN completed\r\n`;
    if (verb === 'LOGOUT') return '';
    if (verb === 'EXAMINE') {
      const uidNext = Math.max(0, ...server.messages.map((m) => m.uid)) + 1;
      return `* ${server.messages.length} EXISTS\r\n* OK [UIDVALIDITY ${server.uidValidity}] UIDs valid\r\n` +
        `* OK [UIDNEXT ${uidNext}] Predicted next UID\r\n${tag} OK [READ-ONLY] EXAMINE completed\r\n`;
    }
    if (verb === 'UID' && sub === 'SEARCH') {
      const after = rest[0] === 'UID' ? Number(rest[1].split(':')[0]) - 1 : 0;
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
        const internalDate = m.internalDate && data.includes('INTERNALDATE') ? ` INTERNALDATE "${m.internalDate}"` : '';
        return `* ${i + 1} FETCH (UID ${m.uid}${internalDate} BODY[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID)] {${Buffer.byteLength(block)}}\r\n${block})\r\n`;
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
      server.written.push(data);
      const reply = answer(data);
      const wait = data.trim().split(' ')[1] === 'LOGIN' && server.gate ? server.gate : Promise.resolve();
      if (reply) wait.then(() => setImmediate(() => socket.emit('data', Buffer.from(reply))));
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
  parseHeaderResponse,
  parseInternalDate,
  replyDedupeKey,
  replyReceivedAt,
  syncMailboxReplies,
} from '../../lib/imapService';

const mocked = prisma as any;

const NOW = new Date('2026-09-30T12:00:00Z');
const VALIDITY = 1700000000;

const LEADS = [
  { id: 'lead-amy', email: 'amy@acme.test' },
  { id: 'lead-ben', email: 'ben@acme.test' },
];

let mailboxRow: any;
let replies: any[];

function leadsWhere(where: any) {
  const wanted = where.email.in.map((e: string) => e.toLowerCase());
  return LEADS.filter((l) => wanted.includes(l.email));
}

function message(uid: number, headers: string[], internalDate?: string) {
  return { uid, headers, internalDate, body: `body of ${uid}` };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});

  server.uidValidity = VALIDITY;
  server.messages = [];
  server.written = [];
  server.gate = null;
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
  // The table's unique index on (senderAccountId, messageId), with ON CONFLICT DO NOTHING.
  // Postgres treats NULLs as distinct, so rows recorded before messageId never conflict.
  mocked.inboundResponse.createMany.mockImplementation(async ({ data, skipDuplicates }: any) => {
    const clash = replies.some((r) => r.senderAccountId === data.senderAccountId && r.messageId != null && r.messageId === data.messageId);
    if (clash && !skipDuplicates) throw new Error('Unique constraint failed on (senderAccountId, messageId)');
    if (clash) return { count: 0 };
    replies.push(data);
    return { count: 1 };
  });
  mocked.campaignEnrollment.findMany.mockImplementation(async ({ where }: any) =>
    where.leadId === 'lead-amy'
      ? [{ id: 'enr-amy', leadId: 'lead-amy', campaignId: 'cmp-1', status: 'Active', campaign: { id: 'cmp-1', name: 'Q3', stopOnReply: true } }]
      : [],
  );
  mocked.emailDispatch.findFirst.mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('one IMAP sync per mailbox in a process (M51)', () => {
  it('skips a sync of a mailbox already syncing, even when started from another bundle of the module', async () => {
    server.messages = [message(1, ['From: amy@acme.test', 'Subject: Re: Hello', 'Date: Tue, 29 Sep 2026 10:00:00 +0000', 'Message-ID: <amy-1@acme.test>'])];
    let release!: () => void;
    server.gate = new Promise<void>((resolve) => { release = resolve; });

    // The worker's sync, held at LOGIN
    const workerSync = syncMailboxReplies('mbx_1');

    // The Unibox route loads its own copy of the module, as Next.js bundles it apart from instrumentation
    vi.resetModules();
    const routeCopy = await import('../../lib/imapService');
    expect(routeCopy.syncMailboxReplies).not.toBe(syncMailboxReplies);
    expect(await routeCopy.syncMailboxReplies('mbx_1')).toEqual({ success: false, reason: 'Already syncing' });

    release();
    expect(await workerSync).toEqual({ success: true, syncedCount: 1 });
    expect(replies).toHaveLength(1);

    // Finished, so the other copy may sync the mailbox again
    expect(await routeCopy.syncMailboxReplies('mbx_1')).not.toEqual({ success: false, reason: 'Already syncing' });
  });
});

describe('IMAP replies deduplicated by Message-ID per mailbox (M51, M52)', () => {
  it('records a message read twice once, keyed by its Message-ID', async () => {
    server.messages = [
      message(1, ['From: Amy <amy@acme.test>', 'Subject: Re: Hello', 'Date: Tue, 29 Sep 2026 10:00:00 +0000', 'Message-ID: <amy-1@acme.test> (Amy\'s client)']),
      message(2, ['From: ben@acme.test', 'Subject: Re: Hi', 'Date: Tue, 29 Sep 2026 11:00:00 +0000', 'Message-ID:', ' <ben-2@acme.test>']),
    ];

    expect(await syncMailboxReplies('mbx_1')).toEqual({ success: true, syncedCount: 2 });
    expect(replies.map((r) => [r.leadId, r.senderAccountId, r.messageId])).toEqual([
      ['lead-amy', 'mbx_1', '<amy-1@acme.test>'],
      ['lead-ben', 'mbx_1', '<ben-2@acme.test>'],
    ]);
    expect(mocked.campaignEnrollment.updateMany).toHaveBeenCalledTimes(1);

    // Changing the IMAP login resets the checkpoint, so the next sync reads the same mail again
    mailboxRow.imapUidValidity = null;
    mailboxRow.imapLastUid = null;
    mocked.campaignEnrollment.updateMany.mockClear();

    expect(await syncMailboxReplies('mbx_1')).toEqual({ success: true, syncedCount: 0 });
    expect(replies).toHaveLength(2);
    expect(mocked.inboundResponse.createMany).toHaveBeenLastCalledWith(expect.objectContaining({ skipDuplicates: true }));
    expect(mocked.campaignEnrollment.updateMany).not.toHaveBeenCalled();
  });

  it('skips a reply another process recorded while this sync was reading it', async () => {
    server.messages = [
      message(1, ['From: amy@acme.test', 'Subject: Re: Hello', 'Date: Tue, 29 Sep 2026 10:00:00 +0000', 'Message-ID: <amy-1@acme.test>']),
      message(2, ['From: ben@acme.test', 'Subject: Re: Hi', 'Date: Tue, 29 Sep 2026 11:00:00 +0000', 'Message-ID: <ben-2@acme.test>']),
    ];
    // Recorded by the worker in another process, with a Date a minute off (another server's copy, say)
    replies.push({ leadId: 'lead-amy', senderAccountId: 'mbx_1', messageId: '<amy-1@acme.test>', receivedAt: new Date('2026-09-29T10:01:00Z') });

    const result = await syncMailboxReplies('mbx_1');

    expect(result).toEqual({ success: true, syncedCount: 1 });
    expect(replies.map((r) => r.messageId)).toEqual(['<amy-1@acme.test>', '<ben-2@acme.test>']);
    expect(mocked.campaignEnrollment.updateMany).not.toHaveBeenCalled();
    expect(mailboxRow).toMatchObject({ imapUidValidity: VALIDITY, imapLastUid: 2 });
  });

  it('keys a message without a Message-ID by the INBOX UIDVALIDITY and UID', async () => {
    server.messages = [message(5, ['From: amy@acme.test', 'Subject: Re: Hello'])];

    expect(await syncMailboxReplies('mbx_1')).toEqual({ success: true, syncedCount: 1 });
    expect(replies[0].messageId).toBe(`uid ${VALIDITY} 5`);

    mailboxRow.imapLastUid = null;
    expect(await syncMailboxReplies('mbx_1')).toEqual({ success: true, syncedCount: 0 });
    expect(replies).toHaveLength(1);
  });

  it('matches a reply recorded before Message-IDs were stored by lead and a Date within 10 seconds', async () => {
    server.messages = [
      message(1, ['From: amy@acme.test', 'Subject: Re: Hello', 'Date: Tue, 29 Sep 2026 10:00:00 +0000', 'Message-ID: <amy-1@acme.test>']),
      message(2, ['From: amy@acme.test', 'Subject: Re: Hello again', 'Date: Tue, 29 Sep 2026 10:30:00 +0000', 'Message-ID: <amy-2@acme.test>']),
    ];
    replies.push({ leadId: 'lead-amy', senderAccountId: 'mbx_1', messageId: null, receivedAt: new Date('2026-09-29T10:00:04Z') });

    const result = await syncMailboxReplies('mbx_1');

    expect(result).toEqual({ success: true, syncedCount: 1 });
    expect(mocked.inboundResponse.createMany).toHaveBeenCalledTimes(1);
    expect(replies.map((r) => r.messageId)).toEqual([null, '<amy-2@acme.test>']);
  });

  it('dates a reply with a malformed Date by INTERNALDATE and records the replies after it', async () => {
    mailboxRow.imapUidValidity = VALIDITY;
    mailboxRow.imapLastUid = 0;
    server.messages = [
      message(1, ['From: amy@acme.test', 'Subject: Re: Hello', 'Date: Tuesday at ten', 'Message-ID: <amy-1@acme.test>'], '29-Sep-2026 10:15:00 +0200'),
      message(2, ['From: ben@acme.test', 'Subject: Re: Hi', 'Date: Tue, 29 Sep 2026 11:00:00 +0000', 'Message-ID: <ben-2@acme.test>'], '29-Sep-2026 11:00:02 +0000'),
    ];

    const result = await syncMailboxReplies('mbx_1');

    expect(result).toEqual({ success: true, syncedCount: 2 });
    expect(server.written.some((w) => /UID FETCH 1,2 \(UID INTERNALDATE BODY\.PEEK\[HEADER\.FIELDS /.test(w))).toBe(true);
    expect(replies.map((r) => [r.leadId, r.receivedAt.toISOString()])).toEqual([
      ['lead-amy', '2026-09-29T08:15:00.000Z'],
      ['lead-ben', '2026-09-29T11:00:00.000Z'],
    ]);
    expect(mailboxRow.imapLastUid).toBe(2);
  });

  it('dates a reply with no usable Date or INTERNALDATE at the time it was read', async () => {
    server.messages = [message(1, ['From: amy@acme.test', 'Subject: Re: Hello', 'Date: Tue, 29 Sep 12026 10:00:00 +0000', 'Message-ID: <amy-1@acme.test>'])];

    expect(await syncMailboxReplies('mbx_1')).toEqual({ success: true, syncedCount: 1 });
    expect(replies[0].receivedAt).toEqual(NOW);
  });
});

describe('reply key and date helpers (M52)', () => {
  it('keeps a Message-ID as its <...> token and hashes one that is long or not printable ASCII', () => {
    expect(replyDedupeKey(' <abc@acme.test> ', VALIDITY, 3)).toBe('<abc@acme.test>');
    expect(replyDedupeKey('(comment) <abc@acme.test> (trailing)', VALIDITY, 3)).toBe('<abc@acme.test>');
    expect(replyDedupeKey('abc@acme.test', VALIDITY, 3)).toBe('abc@acme.test');
    expect(replyDedupeKey('', VALIDITY, 3)).toBe(`uid ${VALIDITY} 3`);
    expect(replyDedupeKey('   ', 7, 42)).toBe('uid 7 42');

    const long = `<${'x'.repeat(3000)}@acme.test>`;
    const hashed = replyDedupeKey(long, VALIDITY, 3);
    expect(hashed).toMatch(/^sha256 [0-9a-f]{64}$/);
    expect(replyDedupeKey(long, 1, 99)).toBe(hashed);
    expect(replyDedupeKey(`<${'y'.repeat(3000)}@acme.test>`, VALIDITY, 3)).not.toBe(hashed);

    // Raw 8-bit octets, as read off the socket
    const nonAscii = replyDedupeKey(Buffer.from('<grüße@acme.test>', 'utf8').toString('latin1'), VALIDITY, 3);
    expect(nonAscii).toMatch(/^sha256 [0-9a-f]{64}$/);
    expect(nonAscii).not.toContain('\0');
  });

  it('reads INTERNALDATE with its zone, a space-padded day and any month case', () => {
    expect(parseInternalDate('17-Jul-1996 02:44:25 -0700')?.toISOString()).toBe('1996-07-17T09:44:25.000Z');
    expect(parseInternalDate(' 7-jul-2026 02:44:25 +0000')?.toISOString()).toBe('2026-07-07T02:44:25.000Z');
    expect(parseInternalDate('17-Foo-1996 02:44:25 -0700')).toBeNull();
    expect(parseInternalDate('yesterday')).toBeNull();
    expect(parseInternalDate(null)).toBeNull();
    expect(parseInternalDate(undefined)).toBeNull();
  });

  it('prefers the Date header, then INTERNALDATE, then now, never returning an Invalid Date', () => {
    const now = new Date('2026-09-30T12:00:00Z');
    const internal = '29-Sep-2026 10:15:00 +0200';
    expect(replyReceivedAt('Tue, 29 Sep 2026 10:00:00 +0000', internal, now).toISOString()).toBe('2026-09-29T10:00:00.000Z');
    expect(replyReceivedAt('not a date', internal, now).toISOString()).toBe('2026-09-29T08:15:00.000Z');
    expect(replyReceivedAt('', internal, now).toISOString()).toBe('2026-09-29T08:15:00.000Z');
    expect(replyReceivedAt('Tue, 29 Sep 12026 10:00:00 +0000', internal, now).toISOString()).toBe('2026-09-29T08:15:00.000Z');
    expect(replyReceivedAt('not a date', 'garbage', now)).toBe(now);
    expect(replyReceivedAt('', undefined, now)).toBe(now);
  });

  it('reads INTERNALDATE from a header FETCH response when the Date header is unreadable', () => {
    const block = 'From: amy@acme.test\r\nDate: 32 Smarch 2026\r\nMessage-ID: <amy-1@acme.test>\r\n\r\n';
    const resp = `* 1 FETCH (UID 9 INTERNALDATE "29-Sep-2026 10:15:00 +0200" BODY[HEADER.FIELDS (FROM DATE MESSAGE-ID)] {${block.length}}\r\n${block})\r\nA4 OK FETCH completed\r\n`;

    const [header] = parseHeaderResponse(resp);

    expect(header.uid).toBe(9);
    expect(header.messageId).toBe('<amy-1@acme.test>');
    expect(header.date.toISOString()).toBe('2026-09-29T08:15:00.000Z');
  });
});
