import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// Fake IMAP server that reads LOGIN arguments the way RFC 3501 defines them: a quoted
// string (only \\ and \" escapes, 7-bit, no CR/LF) or a {n} literal it asks for with a
// "+" continuation request. It accepts only the mailbox's real credentials.
const server = vi.hoisted(() => ({
  written: [] as string[],
  user: '',
  pass: '',
  logins: [] as { user: string; pass: string }[],
}));

vi.mock('tls', () => {
  /** LOGIN's two astrings from the command's octets after "LOGIN ", or null when malformed. */
  const readAstrings = (s: string): string[] | null => {
    const args: string[] = [];
    let i = 0;
    while (args.length < 2) {
      if (s[i] === ' ') {
        i++;
      } else if (s[i] === '"') {
        let value = '';
        for (i++; s[i] !== '"'; i++) {
          if (i >= s.length || s[i] === '\r' || s[i] === '\n' || s.charCodeAt(i) > 0x7f) return null;
          if (s[i] === '\\') {
            i++;
            if (s[i] !== '\\' && s[i] !== '"') return null;
          }
          value += s[i];
        }
        i++;
        args.push(value);
      } else if (s[i] === '{') {
        const literal = /^\{(\d+)\}\r\n/.exec(s.substring(i));
        if (!literal) return null;
        i += literal[0].length;
        args.push(Buffer.from(s.substring(i, i + Number(literal[1])), 'latin1').toString('utf8'));
        i += Number(literal[1]);
      } else {
        const atom = /^[^\s(){"\\]+/.exec(s.substring(i));
        if (!atom) return null;
        args.push(atom[0]);
        i += atom[0].length;
      }
    }
    return s.substring(i) === '\r\n' ? args : null;
  };

  const connect = () => {
    const socket: any = new EventEmitter();
    socket.setTimeout = () => {};
    socket.end = () => setImmediate(() => socket.emit('close'));
    socket.destroy = () => setImmediate(() => socket.emit('close'));
    const reply = (text: string) => setImmediate(() => socket.emit('data', Buffer.from(text)));
    // Octets of the command received so far, one char per octet
    let pending = '';
    socket.write = (data: string) => {
      server.written.push(data);
      pending += Buffer.from(data, 'utf8').toString('latin1');
      if (/\{\d+\}\r\n$/.test(pending)) {
        reply('+ Ready for literal data\r\n');
        return true;
      }
      if (!pending.endsWith('\r\n')) return true;
      const command = pending;
      pending = '';
      const [tag, verb] = command.split(' ');
      if (verb === 'LOGIN') {
        const args = readAstrings(command.substring(`${tag} LOGIN `.length));
        if (!args) {
          reply(`${tag} BAD Invalid arguments\r\n`);
        } else {
          server.logins.push({ user: args[0], pass: args[1] });
          reply(args[0] === server.user && args[1] === server.pass
            ? `${tag} OK LOGIN completed\r\n`
            : `${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`);
        }
      } else if (verb === 'EXAMINE') {
        reply(`* 0 EXISTS\r\n* OK [UIDVALIDITY 3] UIDs valid\r\n* OK [UIDNEXT 1] Predicted next UID\r\n${tag} OK [READ-ONLY] EXAMINE completed\r\n`);
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
    senderAccount: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  },
}));

import { prisma } from '../../lib/db';
import { encryptSecret } from '../../lib/secrets';
import { imapLoginLines, syncMailboxReplies } from '../../lib/imapService';

const mocked = prisma as any;

function useCredentials(user: string, pass: string) {
  server.user = user;
  server.pass = pass;
  mocked.senderAccount.findUnique.mockResolvedValue({
    id: 'mbx_1',
    emailAddress: 'sales@arcreach.test',
    imapHost: 'imap.example.com',
    imapPort: 993,
    imapUser: user,
    imapPass: encryptSecret(pass),
    imapAllowSelfSigned: false,
    imapUidValidity: null,
    imapLastUid: null,
  });
}

function loggedText(): string {
  return [...vi.mocked(console.log).mock.calls, ...vi.mocked(console.error).mock.calls]
    .map((args) => args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '))
    .join('\n');
}

describe('imapLoginLines (L17)', () => {
  it('escapes backslashes and double quotes in quoted strings', () => {
    expect(imapLoginLines('sales@arcreach.test', 'p@ss"w\\rd\\')).toEqual(['LOGIN "sales@arcreach.test" "p@ss\\"w\\\\rd\\\\"']);
  });

  it('sends non-ASCII and CR/LF values as literals sized in UTF-8 octets', () => {
    expect(imapLoginLines('sales@arcreach.test', 'Pässwörd€')).toEqual(['LOGIN "sales@arcreach.test" {13}', 'Pässwörd€']);
    expect(imapLoginLines('jürgen@acme.test', 'a\r\nb')).toEqual(['LOGIN {17}', 'jürgen@acme.test {4}', 'a\r\nb']);
  });
});

describe('IMAP LOGIN (L17)', () => {
  beforeEach(() => {
    server.written = [];
    server.logins = [];
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs in with a password holding quotes and backslashes, one ending in a backslash', async () => {
    useCredentials('sales@arcreach.test', 'C:\\temp\\"quoted"\\');

    const result = await syncMailboxReplies('mbx_1');

    expect(result).toEqual({ success: true, syncedCount: 0 });
    expect(server.logins).toEqual([{ user: 'sales@arcreach.test', pass: 'C:\\temp\\"quoted"\\' }]);
  });

  it('logs in with a non-ASCII user and password sent as literals after continuation requests', async () => {
    useCredentials('jürgen@acme.test', 'Grüße-€-2026');

    const result = await syncMailboxReplies('mbx_1');

    expect(result).toEqual({ success: true, syncedCount: 0 });
    expect(server.logins).toEqual([{ user: 'jürgen@acme.test', pass: 'Grüße-€-2026' }]);
    expect(server.written.slice(0, 3)).toEqual([
      expect.stringMatching(/^A1_LOGIN_\w+ LOGIN \{17\}\r\n$/),
      'jürgen@acme.test {16}\r\n',
      'Grüße-€-2026\r\n',
    ]);
    expect(server.written[3]).toMatch(/^A2_EXAMINE_\w+ EXAMINE INBOX\r\n$/);
    expect(loggedText()).not.toContain('Grüße-€-2026');
  });
});
