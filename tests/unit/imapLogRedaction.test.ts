import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// Fake IMAP server: every command the client writes is recorded, and a canned
// tagged response is pushed back asynchronously like a real TLS socket would.
const server = vi.hoisted(() => ({
  written: [] as string[],
}));

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
      else if (verb === 'EXAMINE') reply = `* 1 EXISTS\r\n* OK [UIDVALIDITY 7] UIDs valid\r\n* OK [UIDNEXT 2] Predicted next UID\r\n${tag} OK [READ-ONLY] EXAMINE completed\r\n`;
      else if (verb === 'UID' && sub === 'SEARCH') reply = `* SEARCH\r\n${tag} OK SEARCH completed\r\n`;
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
  },
}));

import { prisma } from '../../lib/db';
import { encryptSecret } from '../../lib/secrets';
import { describeImapCommand, syncMailboxReplies } from '../../lib/imapService';

const PASSWORD = 'MyAppPassword123';

function loggedLines(): string[] {
  const calls = [
    ...vi.mocked(console.log).mock.calls,
    ...vi.mocked(console.error).mock.calls,
    ...vi.mocked(console.warn).mock.calls,
  ];
  return calls.map(args =>
    args
      .map(a => (a instanceof Error ? `${a.message}\n${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ')
  );
}

describe('describeImapCommand', () => {
  it('drops LOGIN arguments so neither user nor password is logged', () => {
    const line = describeImapCommand('A1_LOGIN_abc123', `LOGIN "sales@acme.com" "${PASSWORD}"`);
    expect(line).toBe('A1_LOGIN_abc123 LOGIN');
  });

  it('keeps only the verb for commands with arguments', () => {
    expect(describeImapCommand('A4_FETCH_HEADERS_x1', 'FETCH 1,2,3 (BODY[HEADER.FIELDS (FROM SUBJECT)])'))
      .toBe('A4_FETCH_HEADERS_x1 FETCH');
    expect(describeImapCommand('A2_SELECT_x2', 'SELECT INBOX')).toBe('A2_SELECT_x2 SELECT');
  });
});

describe('syncMailboxReplies logging', () => {
  beforeEach(() => {
    server.written = [];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(prisma.senderAccount.findUnique).mockResolvedValue({
      id: 'mbx_1',
      emailAddress: 'sales@acme.com',
      imapHost: 'imap.example.com',
      imapPort: 993,
      imapUser: 'sales@acme.com',
      imapPass: encryptSecret(PASSWORD),
    } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends the real LOGIN but logs only tag and verb for every command', async () => {
    const result = await syncMailboxReplies('mbx_1');

    expect(result).toEqual({ success: true, syncedCount: 0 });

    // Protocol behaviour unchanged: the server still receives the decrypted password.
    const loginWrite = server.written.find(w => / LOGIN /.test(w));
    expect(loginWrite).toContain(`"sales@acme.com" "${PASSWORD}"`);

    const expectedSendLines = server.written
      .filter(w => !/ LOGOUT/.test(w))
      .map(w => {
        const [tag, verb] = w.trim().split(/\s+/);
        return `[IMAP Sync] Sending: ${tag} ${verb}`;
      });
    const sendLines = loggedLines().filter(l => l.startsWith('[IMAP Sync] Sending:'));
    expect(sendLines).toEqual(expectedSendLines);
    expect(sendLines.map(l => l.split(' ').pop())).toEqual(['LOGIN', 'EXAMINE', 'UID']);

    for (const line of loggedLines()) {
      expect(line).not.toContain(PASSWORD);
    }
  });
});
