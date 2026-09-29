import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// Fake IMAP server holding one reply, sent back as UTF-8 octets in 5-byte chunks so
// multi-byte characters and literals are split across 'data' events like on a real socket.
const server = vi.hoisted(() => ({
  written: [] as string[],
  headers: '',
  body: '',
}));

vi.mock('tls', () => {
  const literal = (text: string) => `{${Buffer.byteLength(text, 'utf8')}}\r\n${text}`;
  const connect = () => {
    const socket: any = new EventEmitter();
    socket.setTimeout = () => {};
    socket.end = () => setImmediate(() => socket.emit('close'));
    socket.destroy = () => setImmediate(() => socket.emit('close'));
    const send = (reply: string) => {
      const bytes = Buffer.from(reply, 'utf8');
      setImmediate(() => {
        for (let i = 0; i < bytes.length; i += 5) socket.emit('data', bytes.subarray(i, i + 5));
      });
    };
    socket.write = (data: string) => {
      server.written.push(data);
      const [tag, verb, sub] = data.trim().split(/\s+/);
      if (verb === 'LOGIN') send(`${tag} OK LOGIN completed\r\n`);
      else if (verb === 'EXAMINE') send(`* 1 EXISTS\r\n* OK [UIDVALIDITY 9] UIDs valid\r\n* OK [UIDNEXT 8] Predicted next UID\r\n${tag} OK [READ-ONLY] EXAMINE completed\r\n`);
      else if (verb === 'UID' && sub === 'SEARCH') send(`* SEARCH 7\r\n${tag} OK SEARCH completed\r\n`);
      else if (verb === 'UID' && sub === 'FETCH' && data.includes('HEADER.FIELDS')) {
        send(`* 1 FETCH (UID 7 BODY[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID IN-REPLY-TO REFERENCES CONTENT-TYPE CONTENT-TRANSFER-ENCODING)] ${literal(server.headers)})\r\n${tag} OK Success\r\n`);
      } else if (verb === 'UID' && sub === 'FETCH') {
        send(`* 1 FETCH (BODY[TEXT] ${literal(server.body)} UID 7 FLAGS (\\Seen))\r\n${tag} OK Success\r\n`);
      }
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
    campaignEnrollment: { findMany: vi.fn(), update: vi.fn() },
    emailDispatch: { findFirst: vi.fn() },
  },
}));

import { prisma } from '../../lib/db';
import { encryptSecret } from '../../lib/secrets';
import { decodeCharset, decodeMimeHeader } from '../../lib/mime';
import {
  cleanMimeBody,
  decodeQuotedPrintable,
  parseBodyResponse,
  parseHeaderFields,
  parseHeaderResponse,
  parseMailboxAddress,
  syncMailboxReplies,
} from '../../lib/imapService';

const mocked = prisma as any;

/** Text as the sync reads it off the socket: its UTF-8 octets, one char per octet. */
function wire(text: string): string {
  return Buffer.from(text, 'utf8').toString('latin1');
}

/** A FETCH response carrying `text` (already one char per octet) as a literal of its exact length. */
function fetchResponse(seq: number, before: string, text: string, after: string): string {
  return `* ${seq} FETCH (${before} {${text.length}}\r\n${text}${after})\r\n`;
}

const HEADER_SECTION = 'BODY[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID IN-REPLY-TO REFERENCES CONTENT-TYPE CONTENT-TRANSFER-ENCODING)]';

// An Outlook reply's header fields, in message order: the From display name is an
// encoded word folded onto its own line, the Subject holds "Date:" and is folded,
// and Subject comes before Date.
const OUTLOOK_HEADERS = [
  'From: =?utf-8?B?SsO8cmdlbiBNw7xsbGVy?=',
  '\t<Juergen.Mueller@acme.test>',
  'Subject: Re: Save the Date: March 5 =?utf-8?Q?=E2=80=93?= Q3 pipeline',
  ' review',
  'Date: Tue, 29 Sep 2026 14:05:31 +0000',
  'Message-ID: <AM9PR07MB7777@AM9PR07MB7777.eurprd07.prod.outlook.test>',
  'In-Reply-To: <cmp-1.lead-1.step-1@arcreach.test>',
  'References: <cmp-1.lead-1.step-0@arcreach.test>',
  ' <cmp-1.lead-1.step-1@arcreach.test>',
  'Content-Type: text/plain; charset="utf-8"',
  'Content-Transfer-Encoding: base64',
  '',
  '',
].join('\r\n');

// Its single-part body: base64 of UTF-8 text wrapped at 76 characters, with Outlook's quoted history.
const OUTLOOK_BODY = [
  'VGhhdOKAmXMgZ3JlYXQsIGxldOKAmXMgdGFsayBUaHVyc2RheSBhdCAycG0uDQoNCkJlc3QsDQpK',
  'w7xyZ2VuDQoNCkZyb206IFNhbGVzIDxzYWxlc0BhcmNyZWFjaC50ZXN0Pg0KU2VudDogVHVlc2Rh',
  'eSwgU2VwdGVtYmVyIDI5LCAyMDI2IDk6MDAgQU0NClN1YmplY3Q6IFNhdmUgdGhlIERhdGU6IE1h',
  'cmNoIDUNCg0KSGkgSsO8cmdlbiwNCg==',
  '',
].join('\r\n');

describe('IMAP header parsing (H33)', () => {
  it('unfolds headers and reads From, Subject and Date only at line starts', () => {
    const [header] = parseHeaderResponse(
      fetchResponse(1, `UID 7 ${HEADER_SECTION}`, OUTLOOK_HEADERS, '') + 'A4 OK Success\r\n'
    );

    expect(header).toMatchObject({
      uid: 7,
      from: 'juergen.mueller@acme.test',
      subject: 'Re: Save the Date: March 5 – Q3 pipeline review',
      messageId: '<AM9PR07MB7777@AM9PR07MB7777.eurprd07.prod.outlook.test>',
      inReplyTo: '<cmp-1.lead-1.step-1@arcreach.test>',
      references: '<cmp-1.lead-1.step-0@arcreach.test> <cmp-1.lead-1.step-1@arcreach.test>',
      contentType: 'text/plain; charset="utf-8"',
      transferEncoding: 'base64',
    });
    // Not "March 5" from the Subject, which parses as 2001
    expect(header.date.toISOString()).toBe('2026-09-29T14:05:31.000Z');
  });

  it('never takes a field from inside another field value', () => {
    const headers = [
      'Subject: Fwd: From: news@vendor.test',
      'From: Amy Adams <amy@acme.test>',
      'Date: Wed, 30 Sep 2026 08:15:00 -0700 (PDT)',
      '',
      '',
    ].join('\r\n');

    const [header] = parseHeaderResponse(fetchResponse(3, `UID 12 ${HEADER_SECTION}`, headers, ''));

    expect(header.from).toBe('amy@acme.test');
    expect(header.subject).toBe('Fwd: From: news@vendor.test');
    expect(header.date.toISOString()).toBe('2026-09-30T15:15:00.000Z');
  });

  it('decodes a folded subject split over two encoded words and a raw UTF-8 one', () => {
    const gmail = [
      'Subject: =?UTF-8?Q?Re=3A_Quick_question_about_your_Q3_pipeline_=E2=80=94_c?=',
      ' =?UTF-8?Q?an_we_talk=3F?=',
      'From: Amy <amy@acme.test>',
      '',
      '',
    ].join('\r\n');
    const raw = wire(['From: ben@acme.test', 'Subject: Re: Grüße aus München', '', ''].join('\r\n'));

    const parsed = parseHeaderResponse(
      fetchResponse(1, `UID 1 ${HEADER_SECTION}`, gmail, '') + fetchResponse(2, HEADER_SECTION, raw, ' UID 2')
    );

    expect(parsed.map((h) => h.subject)).toEqual([
      'Re: Quick question about your Q3 pipeline — can we talk?',
      'Re: Grüße aus München',
    ]);
  });

  it('reads the address of a From header, whatever its display name holds', () => {
    expect(parseMailboxAddress('"Smith, John <Sales>" <John.Smith@acme.test>')).toBe('John.Smith@acme.test');
    expect(parseMailboxAddress('amy@acme.test (Amy Adams, <Acme>)')).toBe('amy@acme.test');
    expect(parseMailboxAddress('=?utf-8?B?SsO8cmdlbiBNw7xsbGVy?= <juergen@acme.test>')).toBe('juergen@acme.test');
    expect(parseMailboxAddress('ben@acme.test')).toBe('ben@acme.test');
    expect(parseMailboxAddress('<cara@acme.test>, dan@acme.test')).toBe('cara@acme.test');
  });

  it('keeps the first of repeated fields and ignores continuation and malformed lines', () => {
    const fields = parseHeaderFields('X-Note: a\r\n  b\r\nnot a header\r\nX-Note: c\r\nsubject : Hi\r\n');
    expect(fields.get('x-note')).toBe('a  b');
    expect(fields.get('subject')).toBe('Hi');
    expect(fields.size).toBe(2);
  });

  it('skips a response without a UID or without a From address', () => {
    const noFrom = ['Subject: Hi', '', ''].join('\r\n');
    const resp = fetchResponse(1, `UID 3 ${HEADER_SECTION}`, noFrom, '') + '* 2 FETCH (FLAGS (\\Seen))\r\n';
    expect(parseHeaderResponse(resp)).toEqual([]);
  });
});

describe('IMAP body parsing (L16)', () => {
  it('returns exactly the BODY[TEXT] literal, without FLAGS, the closing parenthesis or the tagged OK', () => {
    const body = 'Sounds good, see you Thursday :)\r\n';
    const resp = fetchResponse(4, 'UID 4521 BODY[TEXT]', body, ' FLAGS (\\Seen)') + 'A5_FETCH_BODY_k2x9q1 OK Success\r\n';

    expect(parseBodyResponse(resp)).toBe(body);
    expect(cleanMimeBody(parseBodyResponse(resp), 'text/plain')).toBe('Sounds good, see you Thursday :)');
  });

  it('reads a literal that contains its own parentheses, braces and CRLF lines', () => {
    const body = 'Line one {12}\r\n) A5 OK fake\r\nlast';
    const resp = fetchResponse(1, 'BODY[TEXT]', body, ' UID 9') + 'A5 OK FETCH completed\r\n';
    expect(parseBodyResponse(resp)).toBe(body);
  });

  it('returns an empty body for NIL', () => {
    expect(parseBodyResponse('* 1 FETCH (UID 9 BODY[TEXT] NIL)\r\nA5 OK done\r\n')).toBe('');
  });
});

describe('IMAP body decoding (M55)', () => {
  it('decodes a single-part base64 reply in its charset', () => {
    expect(cleanMimeBody(OUTLOOK_BODY, 'text/plain; charset="utf-8"', 'base64'))
      .toBe('That’s great, let’s talk Thursday at 2pm.\n\nBest,\nJürgen');
  });

  it('decodes quoted-printable UTF-8 without =3D or soft line breaks', () => {
    // Apple Mail
    const body = 'That=E2=80=99s great =E2=80=94 Thursday works.\r\n\r\nOn Sep 29, 2026, at 10:00, Sales <sales@arcreach.test> wrote:\r\n\r\n> Hi Amy,\r\n';
    expect(cleanMimeBody(body, 'text/plain; charset=utf-8', 'quoted-printable')).toBe('That’s great — Thursday works.');
  });

  it('decodes each part with its own charset and skips attachments', () => {
    const body = [
      'This is a multi-part message in MIME format.',
      '',
      '------=_NextPart_000_0012_01DB1234.56789ABC',
      'Content-Type: text/plain; name="notes.txt"',
      'Content-Disposition: attachment; filename="notes.txt"',
      '',
      'attached notes',
      '------=_NextPart_000_0012_01DB1234.56789ABC',
      'Content-Type: multipart/alternative;',
      '\tboundary="----=_NextPart_001_0013_01DB1234.56789ABC"',
      '',
      '------=_NextPart_001_0013_01DB1234.56789ABC',
      'Content-Type: text/plain;',
      '\tcharset="iso-8859-1"',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      'Merci, =E0 bient=F4t !',
      '',
      '------=_NextPart_001_0013_01DB1234.56789ABC',
      'Content-Type: text/html; charset="iso-8859-1"',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      '<p>Merci, =E0 bient=F4t !</p>',
      '------=_NextPart_001_0013_01DB1234.56789ABC--',
      '',
      '------=_NextPart_000_0012_01DB1234.56789ABC--',
      '',
    ].join('\r\n');

    expect(cleanMimeBody(body, 'multipart/mixed; boundary="----=_NextPart_000_0012_01DB1234.56789ABC"', '7bit'))
      .toBe('Merci, à bientôt !');
  });

  it('falls back to the HTML part, decoded in its declared charset', () => {
    const body = [
      '--b1',
      'Content-Type: text/html; charset=windows-1252',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      '<div>That=92s great &amp; thanks</div><blockquote>earlier mail</blockquote>',
      '--b1--',
    ].join('\r\n');
    expect(cleanMimeBody(body, 'multipart/alternative; boundary=b1')).toBe('That’s great & thanks');
  });

  it('reads 8-bit text in its declared charset, and undeclared text as UTF-8 or else windows-1252', () => {
    expect(cleanMimeBody(wire('Grüße aus München'), 'text/plain; charset=UTF-8', '8bit')).toBe('Grüße aus München');
    expect(cleanMimeBody(wire('Grüße aus München'), 'text/plain', '')).toBe('Grüße aus München');
    expect(cleanMimeBody('caf\xe9 \x93ok\x94', 'text/plain', '8bit')).toBe('café “ok”');
    expect(cleanMimeBody(Buffer.from([0x82, 0xa0, 0x82, 0xe8]).toString('latin1'), 'text/plain; charset=Shift_JIS', '8bit')).toBe('あり');
  });

  it('returns no text for a body that has no text part', () => {
    expect(cleanMimeBody('JVBERi0xLjQK', 'application/pdf', 'base64')).toBe('');
  });

  it('decodes quoted-printable in the given charset, keeping a stray "="', () => {
    expect(decodeQuotedPrintable('That=E2=80=99s =\r\ngreat')).toBe('That’s great');
    expect(decodeQuotedPrintable('caf=E9 =3D 3 = three', 'iso-8859-1')).toBe('café = 3 = three');
  });

  it('reads header bytes in the declared charset, falling back for unknown or undeclared ones', () => {
    const utf8 = new Uint8Array(Buffer.from('Jürgen'));
    expect(decodeCharset(utf8)).toBe('Jürgen');
    expect(decodeCharset(utf8, 'x-unknown-charset')).toBe('Jürgen');
    expect(decodeCharset(new Uint8Array([0x4a, 0xfc, 0x72]), 'us-ascii')).toBe('Jür');
    expect(decodeCharset(new Uint8Array([0x4a, 0xfc, 0x72]), 'iso-8859-1*de')).toBe('Jür');
    expect(decodeMimeHeader('=?iso-8859-1?Q?Caf=E9?= =?x-unknown?B?w6k=?=')).toBe('Caféé');
  });
});

describe('IMAP reply sync end to end (H33, M55, L16)', () => {
  beforeEach(() => {
    server.written = [];
    server.headers = OUTLOOK_HEADERS;
    server.body = OUTLOOK_BODY;
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
      imapAllowSelfSigned: false,
      imapUidValidity: 9,
      imapLastUid: 6,
    });
    const leads = [{ id: 'lead-1', email: 'juergen.mueller@acme.test' }];
    const leadsWhere = ({ where }: any) => leads.filter((l) => where.email.in.map((e: string) => e.toLowerCase()).includes(l.email));
    mocked.lead.findMany.mockImplementation(async (args: any) => leadsWhere(args));
    mocked.lead.findFirst.mockImplementation(async (args: any) => leadsWhere(args)[0] ?? null);
    mocked.inboundResponse.findFirst.mockResolvedValue(null);
    mocked.inboundResponse.createMany.mockResolvedValue({ count: 1 });
    mocked.emailDispatch.findFirst.mockResolvedValue({ campaignId: 'cmp-1' });
    mocked.campaignEnrollment.findMany.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('records a folded, encoded Outlook reply with its subject, date and decoded body only', async () => {
    const result = await syncMailboxReplies('mbx_1');

    expect(result).toEqual({ success: true, syncedCount: 1 });
    expect(server.written.some((w) => /UID FETCH 7 \(UID INTERNALDATE BODY\.PEEK\[HEADER\.FIELDS \(.*CONTENT-TYPE CONTENT-TRANSFER-ENCODING\)\]\)/.test(w))).toBe(true);
    expect(mocked.inboundResponse.createMany).toHaveBeenCalledWith({
      data: {
        leadId: 'lead-1',
        campaignId: 'cmp-1',
        senderAccountId: 'mbx_1',
        messageId: '<AM9PR07MB7777@AM9PR07MB7777.eurprd07.prod.outlook.test>',
        subject: 'Re: Save the Date: March 5 – Q3 pipeline review',
        body: 'That’s great, let’s talk Thursday at 2pm.\n\nBest,\nJürgen',
        receivedAt: new Date('2026-09-29T14:05:31.000Z'),
        unread: true,
      },
      skipDuplicates: true,
    });
  });

  it('decodes an undeclared 8-bit UTF-8 body split across socket reads', async () => {
    server.headers = ['From: Jürgen <juergen.mueller@acme.test>', 'Subject: Re: Grüße', 'Date: Tue, 29 Sep 2026 14:05:31 +0000', '', ''].join('\r\n');
    server.body = 'Grüße aus München, bis Donnerstag!\r\n';

    const result = await syncMailboxReplies('mbx_1');

    expect(result).toEqual({ success: true, syncedCount: 1 });
    expect(mocked.inboundResponse.createMany).toHaveBeenCalledWith({
      data: expect.objectContaining({ subject: 'Re: Grüße', body: 'Grüße aus München, bis Donnerstag!' }),
      skipDuplicates: true,
    });
  });
});
