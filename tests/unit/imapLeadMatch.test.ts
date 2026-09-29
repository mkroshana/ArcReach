import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// Fake IMAP server with one reply in the inbox, from a lead whose stored email
// differs from the From address only in case.
const server = vi.hoisted(() => ({
  written: [] as string[],
}));

const HEADERS = [
  '* 1 FETCH (UID 1 BODY[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID IN-REPLY-TO REFERENCES)] {90}',
  'From: Vendor News <news@vendor.test>',
  'Subject: Weekly digest',
  'Date: Tue, 29 Sep 2026 10:00:00 +0000',
  '',
  ')',
  '* 2 FETCH (UID 2 BODY[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID IN-REPLY-TO REFERENCES)] {110}',
  'From: John Smith <JOHN.smith@ACME.com>',
  'Subject: Re: Quick question',
  'Date: Tue, 29 Sep 2026 11:00:00 +0000',
  '',
  ')',
].join('\r\n');

vi.mock('tls', () => {
  const connect = () => {
    const socket: any = new EventEmitter();
    socket.setTimeout = () => {};
    socket.end = () => setImmediate(() => socket.emit('close'));
    socket.destroy = () => setImmediate(() => socket.emit('close'));
    socket.write = (data: string) => {
      server.written.push(data);
      const [tag, verb, sub] = data.trim().split(/\s+/);
      let reply = '';
      if (verb === 'LOGIN') reply = `${tag} OK LOGIN completed\r\n`;
      else if (verb === 'EXAMINE') reply = `* 2 EXISTS\r\n* OK [UIDVALIDITY 7] UIDs valid\r\n* OK [UIDNEXT 3] Predicted next UID\r\n${tag} OK [READ-ONLY] EXAMINE completed\r\n`;
      else if (verb === 'UID' && sub === 'SEARCH') reply = `* SEARCH 1 2\r\n${tag} OK SEARCH completed\r\n`;
      else if (verb === 'UID' && sub === 'FETCH' && data.includes('HEADER.FIELDS')) reply = `${HEADERS}\r\n${tag} OK FETCH completed\r\n`;
      else if (verb === 'UID' && sub === 'FETCH') reply = `* 2 FETCH (UID 2 BODY[TEXT] {11}\r\nplease stop\r\n)\r\n${tag} OK FETCH completed\r\n`;
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
    inboundResponse: { findFirst: vi.fn(), create: vi.fn() },
    campaignEnrollment: { findMany: vi.fn(), update: vi.fn() },
    emailDispatch: { findFirst: vi.fn() },
  },
}));

import { prisma } from '../../lib/db';
import { encryptSecret } from '../../lib/secrets';
import { syncMailboxReplies } from '../../lib/imapService';

const mocked = prisma as any;

// Stored before emails were normalised.
const LEADS = [{ id: 'lead-1', email: 'John.Smith@Acme.com' }];

/** Leads matching an email filter the way Postgres evaluates it: an insensitive `in` compares lower() of both sides. */
function leadsWhere(where: any) {
  const cond = where.email;
  const fold = (v: string) => (cond.mode === 'insensitive' ? v.toLowerCase() : v);
  return LEADS.filter((l) => cond.in.map(fold).includes(fold(l.email)));
}

describe('IMAP reply matching', () => {
  beforeEach(() => {
    server.written = [];
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocked.senderAccount.findUnique.mockResolvedValue({
      id: 'mbx_1',
      emailAddress: 'sales@arcreach.test',
      imapHost: 'imap.example.com',
      imapPort: 993,
      imapUser: 'sales@arcreach.test',
      imapPass: encryptSecret('secret'),
    });
    mocked.lead.findMany.mockImplementation(async ({ where }: any) => leadsWhere(where));
    mocked.lead.findFirst.mockImplementation(async ({ where }: any) => leadsWhere(where)[0] ?? null);
    mocked.inboundResponse.findFirst.mockResolvedValue(null);
    mocked.emailDispatch.findFirst.mockResolvedValue({ campaignId: 'cmp-1' });
    mocked.campaignEnrollment.findMany.mockResolvedValue([
      { id: 'enr-1', leadId: 'lead-1', campaignId: 'cmp-1', status: 'Active', campaign: { id: 'cmp-1', name: 'Q3', stopOnReply: true } },
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('records a reply from a mixed-case address against its lead and stops the sequence', async () => {
    const result = await syncMailboxReplies('mbx_1');

    expect(result).toEqual({ success: true, syncedCount: 1 });
    expect(server.written.some((w) => / UID FETCH 2 \(BODY\.PEEK\[TEXT\]\)/.test(w))).toBe(true);
    expect(mocked.inboundResponse.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ leadId: 'lead-1', campaignId: 'cmp-1', senderAccountId: 'mbx_1', body: expect.stringContaining('please stop') }),
    });
    expect(mocked.campaignEnrollment.update).toHaveBeenCalledWith({ where: { id: 'enr-1' }, data: { status: 'Paused' } });
  });
});
