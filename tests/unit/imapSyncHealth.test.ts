import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// Fake IMAP server over a mocked TLS socket. `mode` picks how it fails: refuse LOGIN,
// hang up or go quiet instead of answering it, or fail the connection itself.
const server = vi.hoisted(() => ({
  mode: 'ok' as 'ok' | 'login-no' | 'hang-up' | 'silent' | 'error',
  loginReply: '',
  error: null as Error | null,
  written: [] as string[],
}));

vi.mock('tls', () => {
  const connect = () => {
    const socket: any = new EventEmitter();
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      setImmediate(() => socket.emit('close'));
    };
    // The idle timer is the test's to fire, as the 'silent' server does.
    socket.setTimeout = () => {};
    socket.end = close;
    socket.destroy = close;
    socket.write = (data: string) => {
      server.written.push(data);
      const [tag, verb] = data.trim().split(/\s+/);
      if (verb === 'LOGIN' && server.mode === 'hang-up') {
        close();
      } else if (verb === 'LOGIN' && server.mode === 'silent') {
        setImmediate(() => socket.emit('timeout'));
      } else if (verb === 'LOGIN') {
        const reply = server.mode === 'login-no' ? `* CAPABILITY IMAP4rev1\r\n${tag} ${server.loginReply}\r\n` : `${tag} OK LOGIN completed\r\n`;
        setImmediate(() => socket.emit('data', Buffer.from(reply)));
      } else if (verb === 'EXAMINE') {
        const reply = `* 0 EXISTS\r\n* OK [UIDVALIDITY 7] UIDs valid\r\n* OK [UIDNEXT 1] Predicted next UID\r\n${tag} OK [READ-ONLY] EXAMINE completed\r\n`;
        setImmediate(() => socket.emit('data', Buffer.from(reply)));
      }
      return true;
    };
    setImmediate(() => {
      if (server.mode === 'error') {
        // Node reports a failed TLS connection with 'error', then 'close'
        socket.emit('error', server.error);
        close();
        return;
      }
      socket.emit('data', Buffer.from('* OK IMAP4rev1 Service Ready\r\n'));
    });
    return socket;
  };
  return { default: { connect }, connect };
});

vi.mock('../../lib/db', () => ({
  prisma: {
    senderAccount: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  },
}));

import { prisma } from '../../lib/db';
import { encryptSecret } from '../../lib/secrets';
import { getActiveImapAccounts, imapSyncFailureMessage, syncMailboxReplies } from '../../lib/imapService';
import { IMAP_SYNC_LABELS, MICROSOFT_IMAP_NOTE, imapSyncState, isMicrosoftImapHost, stopOnReplyWarning } from '../../lib/imapSyncStatus';

const mocked = prisma as any;

const MAILBOX = {
  id: 'mbx_1',
  emailAddress: 'sales@acme.test',
  provider: 'Azure Relay Node',
  status: 'Active',
  imapHost: 'imap.example.com',
  imapPort: 993,
  imapUser: 'sales@acme.test',
  imapPass: encryptSecret('secret'),
  imapAllowSelfSigned: false,
  imapUidValidity: null,
  imapLastUid: null,
};

/** The status the sync saved on the mailbox. */
function savedStatus() {
  expect(mocked.senderAccount.update).toHaveBeenCalledTimes(1);
  const [{ where, data }] = mocked.senderAccount.update.mock.calls[0];
  expect(where).toEqual({ id: 'mbx_1' });
  return data;
}

function connectionError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

beforeEach(() => {
  server.mode = 'ok';
  server.loginReply = '';
  server.error = null;
  server.written = [];
  vi.clearAllMocks();
  mocked.senderAccount.findUnique.mockResolvedValue(MAILBOX);
  mocked.senderAccount.update.mockResolvedValue({});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('reply sync failures are saved on the mailbox and told apart (M57)', () => {
  it('fails a refused LOGIN at once, saving the server reason, and goes no further', async () => {
    server.mode = 'login-no';
    server.loginReply = 'NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)';

    // Before the fix the LOGIN handler's throw escaped the socket's data event, and
    // the sync never settled (this fake never fires its idle timer on its own).
    const result = await syncMailboxReplies('mbx_1');

    expect(result).toEqual({ success: false, error: 'IMAP Login failed: NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)' });
    expect(savedStatus()).toEqual({
      imapLastSyncError: 'Login refused by imap.example.com: NO [AUTHENTICATIONFAILED] Invalid credentials (Failure). Check the IMAP username and password.',
    });
    expect(server.written.some((w) => /EXAMINE|LOGOUT/.test(w))).toBe(false);
    expect(mocked.senderAccount.updateMany).not.toHaveBeenCalled();
  });

  it('says why a Microsoft 365 mailbox can never log in', async () => {
    server.mode = 'login-no';
    server.loginReply = 'NO LOGIN failed.';
    mocked.senderAccount.findUnique.mockResolvedValue({ ...MAILBOX, imapHost: 'outlook.office365.com' });

    await syncMailboxReplies('mbx_1');

    expect(savedStatus().imapLastSyncError).toBe(
      `Login refused by outlook.office365.com: NO LOGIN failed. Check the IMAP username and password. ${MICROSOFT_IMAP_NOTE}`
    );
  });

  it('fails a sync the server hangs up on, which used to count as a success with nothing to read', async () => {
    server.mode = 'hang-up';

    const result = await syncMailboxReplies('mbx_1');

    expect(result).toEqual({ success: false, error: 'IMAP connection closed before the sync finished' });
    expect(savedStatus()).toEqual({ imapLastSyncError: 'imap.example.com closed the connection before the sync finished.' });
    expect(mocked.senderAccount.updateMany).not.toHaveBeenCalled();
  });

  it('tells a timeout apart from a refused login', async () => {
    server.mode = 'silent';

    const result = await syncMailboxReplies('mbx_1');

    expect(result.success).toBe(false);
    expect(savedStatus()).toEqual({ imapLastSyncError: 'Timed out: imap.example.com:993 did not answer within 15 seconds.' });
  });

  it('tells a refused TLS certificate apart, pointing a self-signed one at the opt-in', async () => {
    server.mode = 'error';
    server.error = connectionError('self-signed certificate', 'DEPTH_ZERO_SELF_SIGNED_CERT');

    const result = await syncMailboxReplies('mbx_1');

    expect(result).toEqual({ success: false, error: 'self-signed certificate' });
    expect(savedStatus()).toEqual({
      imapLastSyncError: 'Certificate refused: the TLS certificate of imap.example.com could not be verified (self-signed certificate). Turn on Allow Self-Signed Certificate only if you run this server yourself.',
    });
  });

  it('tells a connection that could not be made apart', async () => {
    server.mode = 'error';
    server.error = connectionError('connect ECONNREFUSED 192.0.2.1:993', 'ECONNREFUSED');

    await syncMailboxReplies('mbx_1');

    expect(savedStatus()).toEqual({ imapLastSyncError: 'Could not connect to imap.example.com:993: connect ECONNREFUSED 192.0.2.1:993.' });
  });

  it('stamps the sync time and clears the error after a successful sync', async () => {
    const before = Date.now();

    const result = await syncMailboxReplies('mbx_1');

    expect(result).toEqual({ success: true, syncedCount: 0 });
    const data = savedStatus();
    expect(data.imapLastSyncError).toBeNull();
    expect(data.imapLastSyncAt).toBeInstanceOf(Date);
    expect(data.imapLastSyncAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('keeps the sync result when the status fails to save', async () => {
    mocked.senderAccount.update.mockRejectedValue(new Error('database unavailable'));

    expect(await syncMailboxReplies('mbx_1')).toEqual({ success: true, syncedCount: 0 });
    expect(console.error).toHaveBeenCalledWith('[IMAP Sync] Could not save the sync result of mailbox mbx_1:', expect.any(Error));
  });

  it('saves nothing for a mailbox without IMAP details', async () => {
    mocked.senderAccount.findUnique.mockResolvedValue({ ...MAILBOX, imapPass: null });

    expect(await syncMailboxReplies('mbx_1')).toEqual({ success: false, reason: 'Not configured' });
    expect(mocked.senderAccount.update).not.toHaveBeenCalled();
  });
});

describe('imapSyncFailureMessage (M57)', () => {
  it('names the certificate problem without the self-signed hint when the certificate is for another host', () => {
    const err = connectionError("Hostname/IP does not match certificate's altnames: Host: imap.example.com. is not in the cert's altnames: DNS:mail.other.test", 'ERR_TLS_CERT_ALTNAME_INVALID');
    const message = imapSyncFailureMessage(err, 'imap.example.com', 993);
    expect(message).toMatch(/^Certificate refused: the TLS certificate of imap\.example\.com could not be verified \(Hostname\/IP does not match/);
    expect(message).not.toContain('Allow Self-Signed Certificate');
  });

  it('points a TLS handshake failure at the implicit TLS port', () => {
    expect(imapSyncFailureMessage(connectionError('wrong version number', 'ERR_SSL_WRONG_VERSION_NUMBER'), 'imap.example.com', 143)).toBe(
      'TLS handshake with imap.example.com:143 failed (wrong version number). Reply sync uses TLS from the start, usually on port 993.'
    );
  });

  it('reports a host that does not resolve as a connection failure', () => {
    expect(imapSyncFailureMessage(connectionError('getaddrinfo ENOTFOUND imap.typo.test', 'ENOTFOUND'), 'imap.typo.test', 993)).toBe(
      'Could not connect to imap.typo.test:993: getaddrinfo ENOTFOUND imap.typo.test.'
    );
  });

  it('keeps any other error on one line and at most 300 characters', () => {
    expect(imapSyncFailureMessage(new Error('IMAP EXAMINE failed:\r\n NO Mailbox does not exist'), 'imap.example.com', 993)).toBe(
      'Sync failed: IMAP EXAMINE failed: NO Mailbox does not exist'
    );
    const long = imapSyncFailureMessage(new Error('x'.repeat(1000)), 'imap.example.com', 993);
    expect(long).toHaveLength(300);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('getActiveImapAccounts (M21)', () => {
  const ROWS = [
    { ...MAILBOX, id: 'azure', provider: 'Azure Relay Node', userId: 'user-1' },
    { ...MAILBOX, id: 'sendgrid', provider: 'SendGrid Relay Node', userId: 'user-2' },
    { ...MAILBOX, id: 'no-imap', provider: 'Google Workspace', userId: 'user-1', imapHost: null, imapPass: null },
    { ...MAILBOX, id: 'paused', provider: 'Google Workspace', userId: 'user-1', status: 'Paused' },
  ];

  beforeEach(() => {
    // Applies the where clause the way Postgres would, including any provider filter
    mocked.senderAccount.findMany.mockImplementation(async ({ where }: any) => ROWS.filter((row) =>
      Object.entries(where).every(([field, cond]: [string, any]) => {
        const value = (row as any)[field];
        if (cond && typeof cond === 'object' && 'not' in cond) return cond.not === null ? value != null : value !== cond.not;
        return value === cond;
      })
    ));
  });

  it('syncs every Active mailbox with IMAP details, whatever its provider label', async () => {
    expect((await getActiveImapAccounts('', 'ADMIN')).map((m) => m.id)).toEqual(['azure', 'sendgrid']);
    expect((await getActiveImapAccounts('user-1', 'USER')).map((m) => m.id)).toEqual(['azure']);
  });
});

describe('imapSyncState (M57)', () => {
  const configured = { status: 'Active', imapHost: 'imap.example.com', imapPort: 993, imapUser: 'sales@acme.test', imapPass: '********' };

  it('is off without complete IMAP details or for a mailbox that is not Active', () => {
    for (const missing of ['imapHost', 'imapPort', 'imapUser', 'imapPass']) {
      expect(imapSyncState({ ...configured, [missing]: null })).toBe('off');
    }
    expect(imapSyncState({ ...configured, status: 'Paused', imapLastSyncAt: '2026-09-30T08:00:00Z' })).toBe('off');
  });

  it('is failing after a failed sync, ok after a successful one, else waiting', () => {
    expect(imapSyncState({ ...configured, imapLastSyncAt: '2026-09-30T08:00:00Z', imapLastSyncError: 'Timed out' })).toBe('failing');
    expect(imapSyncState({ ...configured, imapLastSyncAt: '2026-09-30T08:00:00Z', imapLastSyncError: null })).toBe('ok');
    expect(imapSyncState(configured)).toBe('waiting');
    expect(IMAP_SYNC_LABELS.failing).toBe('Reply Sync Failing');
  });

  it('recognises the Microsoft 365 and Outlook.com IMAP hosts only', () => {
    expect(isMicrosoftImapHost('outlook.office365.com')).toBe(true);
    expect(isMicrosoftImapHost('imap-mail.outlook.com')).toBe(true);
    expect(isMicrosoftImapHost('imap.gmail.com')).toBe(false);
    expect(isMicrosoftImapHost('mail.notoutlook.com')).toBe(false);
    expect(isMicrosoftImapHost(null)).toBe(false);
  });
});

describe('stopOnReplyWarning (M21)', () => {
  const imap = { status: 'Active', imapHost: 'imap.example.com', imapPort: 993, imapUser: 'u', imapPass: '********' };
  const ok = { ...imap, emailAddress: 'ok@acme.test', imapLastSyncAt: '2026-09-30T08:00:00Z' };
  const failing = { ...imap, emailAddress: 'failing@acme.test', imapLastSyncError: 'Timed out' };
  const waiting = { ...imap, emailAddress: 'waiting@acme.test' };
  const off = { emailAddress: 'off@acme.test', status: 'Active' };

  it('stays quiet when the campaign does not pause on reply, has no sender, or a sender syncs replies', () => {
    expect(stopOnReplyWarning(false, [off])).toBeNull();
    expect(stopOnReplyWarning(true, [])).toBeNull();
    expect(stopOnReplyWarning(true, [off, failing, ok])).toBeNull();
  });

  it('warns when no mailbox in the pool syncs replies, saying why', () => {
    expect(stopOnReplyWarning(true, [off])).toMatch(/^No mailbox that receives this campaign's replies has IMAP set up, so replies are not read and Pause Sequence on Reply cannot pause anyone\./);
    expect(stopOnReplyWarning(true, [off, failing])).toMatch(/^Reply sync is failing on every mailbox/);
    expect(stopOnReplyWarning(true, [off, waiting])).toMatch(/^No mailbox that receives this campaign's replies has finished a reply sync yet/);
  });

  it('counts the mailbox a sender sets as Reply-To, which is where its replies land', () => {
    const sender = { ...off, replyTo: 'OK@acme.test ' };
    expect(stopOnReplyWarning(true, [sender], [sender, ok])).toBeNull();
    expect(stopOnReplyWarning(true, [{ ...off, replyTo: 'failing@acme.test' }], [off, failing])).toMatch(/^Reply sync is failing/);
  });
});
