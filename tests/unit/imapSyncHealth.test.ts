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
import {
  IMAP_SYNC_LABELS, MICROSOFT_IMAP_NOTE, imapSyncState, isMicrosoftImapHost, mailboxRepliesFigure, replyCountUnknown, replySyncState, stopOnReplyWarning,
  mailboxReplySync, mailboxReplySyncLabel, otherReplyTo, unreadReplyToNote, unreadReplyTos,
} from '../../lib/imapSyncStatus';

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
    expect(stopOnReplyWarning(true, [off])).toBe(
      "No mailbox that receives this campaign's replies has reply sync on, so replies are not read and Pause Sequence on Reply cannot pause anyone. "
      + 'Add IMAP details to a sender mailbox on the Accounts page.',
    );
    expect(stopOnReplyWarning(true, [off, failing])).toMatch(/^Reply sync is failing on every mailbox/);
    expect(stopOnReplyWarning(true, [off, waiting])).toMatch(/^No mailbox that receives this campaign's replies has finished a reply sync yet/);
  });

  it('counts the mailbox a sender sets as Reply-To, which is where its replies land', () => {
    const sender = { ...off, replyTo: 'OK@acme.test ' };
    expect(stopOnReplyWarning(true, [sender], [sender, ok])).toBeNull();
    expect(stopOnReplyWarning(true, [{ ...off, replyTo: 'failing@acme.test' }], [off, failing])).toMatch(/^Reply sync is failing/);
  });

  it('warns, naming the address, when the Reply-To is not a mailbox with reply sync on, even though the sender syncs (stats A13)', () => {
    // HR Leads Initial: it sends from one spelling and its Reply-To is another, which is not a mailbox.
    const chui = { ...ok, emailAddress: 'chui@thejobshelpers.com', replyTo: 'chui@thejobhelpers.com' };
    expect(stopOnReplyWarning(true, [chui])).toBe(
      "No mailbox that receives this campaign's replies has reply sync on, so replies are not read and Pause Sequence on Reply cannot pause anyone. "
      + 'Replies to emails from chui@thejobshelpers.com go to the Reply-To address chui@thejobhelpers.com, which is not a mailbox in ArcReach with reply sync on. '
      + 'Set up reply sync for that address, or change the Reply-To, on the Accounts page.',
    );
    // A Paused mailbox with IMAP details as the Reply-To is not synced either, so it is named too.
    const paused = { ...ok, emailAddress: 'paused@acme.test', status: 'Paused' };
    expect(stopOnReplyWarning(true, [{ ...ok, replyTo: 'paused@acme.test' }], [ok, paused]))
      .toContain('go to the Reply-To address paused@acme.test, which is not a mailbox in ArcReach with reply sync on.');
    // Another sender's failing sync is still the lead reason, with the unread address after it.
    const warning = stopOnReplyWarning(true, [chui, failing]);
    expect(warning).toMatch(/^Reply sync is failing on every mailbox/);
    expect(warning).toContain('go to the Reply-To address chui@thejobhelpers.com, which is not a mailbox in ArcReach with reply sync on.');
  });

  it('also suggests adding IMAP details when the pool has a sender with no other Reply-To, which would read its own replies', () => {
    const chui = { ...ok, emailAddress: 'chui@thejobshelpers.com', replyTo: 'chui@thejobhelpers.com' };
    expect(stopOnReplyWarning(true, [chui, off])).toMatch(
      / Set up reply sync for that address, change the Reply-To, or add IMAP details to a sender mailbox that has no other Reply-To, on the Accounts page\.$/,
    );
    // Only Reply-To addresses that are not read: no sender's own IMAP details would help.
    const sam = { ...off, emailAddress: 'sam@acme.test', replyTo: 'help@acme.test' };
    expect(stopOnReplyWarning(true, [chui, sam])).toMatch(/ Set up reply sync for those addresses, or change the Reply-To, on the Accounts page\.$/);
  });
});

describe('replySyncState', () => {
  const imap = { status: 'Active', imapHost: 'imap.example.com', imapPort: 993, imapUser: 'u', imapPass: '********' };
  const ok = { ...imap, emailAddress: 'ok@acme.test', imapLastSyncAt: '2026-09-30T08:00:00Z' };
  const failing = { ...imap, emailAddress: 'failing@acme.test', imapLastSyncError: 'Timed out' };
  const waiting = { ...imap, emailAddress: 'waiting@acme.test' };
  const off = { emailAddress: 'off@acme.test', status: 'Active' };

  it("is the best state among the mailboxes that receive a campaign's replies", () => {
    expect(replySyncState([off, failing, ok])).toBe('ok');
    expect(replySyncState([off, failing, waiting])).toBe('waiting');
    expect(replySyncState([off, failing])).toBe('failing');
    expect(replySyncState([off])).toBe('off');
    expect(replySyncState([])).toBe('off');
  });

  it('counts the mailbox a sender sets as Reply-To', () => {
    expect(replySyncState([{ ...off, replyTo: 'ok@acme.test' }], [off, ok])).toBe('ok');
  });

  it("is off when a sender's Reply-To is not a mailbox with reply sync on, whatever the sender's own sync (stats A13)", () => {
    const chui = { ...ok, emailAddress: 'chui@thejobshelpers.com', replyTo: 'chui@thejobhelpers.com' };
    expect(imapSyncState(chui)).toBe('ok');
    expect(replySyncState([chui])).toBe('off');
    // The Reply-To is a mailbox, but one without IMAP details, or one that is not Active.
    expect(replySyncState([{ ...ok, replyTo: 'off@acme.test' }], [ok, off])).toBe('off');
    expect(replySyncState([{ ...ok, replyTo: 'paused@acme.test' }], [ok, { ...ok, emailAddress: 'paused@acme.test', status: 'Paused' }])).toBe('off');
    // So the campaign's reply count is unknown, not 0.
    expect(replyCountUnknown(replySyncState([chui]), 0)).toBe(true);
  });

  it("is the Reply-To mailbox's state, not the sender's, when the Reply-To is set up", () => {
    expect(replySyncState([{ ...ok, replyTo: 'waiting@acme.test' }], [ok, waiting])).toBe('waiting');
    expect(replySyncState([{ ...ok, replyTo: 'failing@acme.test' }], [ok, failing])).toBe('failing');
    // Matched trimmed and case-insensitively.
    expect(replySyncState([{ ...failing, replyTo: '  OK@ACME.test ' }], [failing, ok])).toBe('ok');
  });

  it("is the sender's own state when its Reply-To is its own address or blank", () => {
    expect(replySyncState([{ ...ok, replyTo: ' OK@Acme.test' }])).toBe('ok');
    expect(replySyncState([{ ...ok, replyTo: '   ' }])).toBe('ok');
    expect(replySyncState([{ ...ok, replyTo: null }])).toBe('ok');
  });

  it('stays the best of the pool, so another sender that syncs its own replies still makes it ok', () => {
    expect(replySyncState([ok, { ...ok, emailAddress: 'chui@thejobshelpers.com', replyTo: 'chui@thejobhelpers.com' }])).toBe('ok');
  });
});

describe("mailboxReplySync, a mailbox's reply-sync chip", () => {
  const imap = { status: 'Active', imapHost: 'imap.gmail.com', imapPort: 993, imapUser: 'u', imapPass: '********' };
  const randy = { ...imap, emailAddress: 'randy@jobpromax.com', imapLastSyncAt: '2026-10-07T12:00:00Z' };
  const team = { emailAddress: 'team@jobpromax.it.com', status: 'Active', replyTo: 'randy@jobpromax.com' };

  it('is the Reply-To mailbox\'s sync for a mailbox with no IMAP of its own, not "Reply Sync Off"', () => {
    const sync = mailboxReplySync(team, [team, randy]);
    expect(sync).toEqual({ state: 'ok', via: 'randy@jobpromax.com', reader: randy });
    expect(mailboxReplySyncLabel(sync)).toBe('Reply Sync OK via Reply-To');
    // Matched trimmed and case-insensitively, as the campaign's reply sync matches it.
    expect(mailboxReplySync({ ...team, replyTo: ' Randy@JobProMax.com ' }, [randy]).state).toBe('ok');
  });

  it("follows the Reply-To mailbox's sync while it is pending or failing", () => {
    const pending = { ...randy, imapLastSyncAt: null };
    const failing = { ...randy, imapLastSyncError: 'Invalid credentials' };
    expect(mailboxReplySyncLabel(mailboxReplySync(team, [team, pending]))).toBe('Reply Sync Pending via Reply-To');
    expect(mailboxReplySync(team, [team, failing])).toEqual({ state: 'failing', via: 'randy@jobpromax.com', reader: failing });
  });

  it('stays off when the Reply-To is not a mailbox with reply sync on', () => {
    const off = { state: 'off' as const, via: null, reader: team };
    // No such mailbox in ArcReach, one without IMAP details, and one that is not Active.
    expect(mailboxReplySync(team, [team])).toEqual(off);
    expect(mailboxReplySync(team)).toEqual(off);
    expect(mailboxReplySync(team, [team, { emailAddress: 'randy@jobpromax.com', status: 'Active' }])).toEqual(off);
    expect(mailboxReplySync(team, [team, { ...randy, status: 'Paused' }])).toEqual(off);
    expect(mailboxReplySyncLabel(off)).toBe('Reply Sync Off');
  });

  it('is its own sync for a mailbox with IMAP details, or with no other Reply-To', () => {
    // Its own sync is what its chip reports, working or failing, whatever its Reply-To.
    const own = { ...randy, emailAddress: 'steve@jobpromax.it.com', replyTo: 'randy@jobpromax.com', imapLastSyncError: 'Timed out' };
    expect(mailboxReplySync(own, [own, randy])).toEqual({ state: 'failing', via: null, reader: own });
    expect(mailboxReplySync(randy, [team, randy])).toEqual({ state: 'ok', via: null, reader: randy });
    expect(mailboxReplySyncLabel(mailboxReplySync(randy, [team, randy]))).toBe('Reply Sync OK');
    // Its Reply-To is its own address or blank: nothing else reads its replies.
    const self = { emailAddress: 'steve@jobpromax.com', status: 'Active', replyTo: 'Steve@jobpromax.com' };
    expect(mailboxReplySync(self, [self, randy])).toEqual({ state: 'off', via: null, reader: self });
    expect(mailboxReplySync({ ...self, replyTo: null }, [randy]).via).toBeNull();
  });
});

describe('unreadReplyTos and unreadReplyToNote (stats A13)', () => {
  const imap = { status: 'Active', imapHost: 'imap.example.com', imapPort: 993, imapUser: 'u', imapPass: '********' };
  const ok = { ...imap, emailAddress: 'ok@acme.test', imapLastSyncAt: '2026-09-30T08:00:00Z' };
  const failing = { ...imap, emailAddress: 'failing@acme.test', imapLastSyncError: 'Timed out' };
  const waiting = { ...imap, emailAddress: 'waiting@acme.test' };
  const off = { emailAddress: 'off@acme.test', status: 'Active' };

  it('names each Reply-To address that is not a mailbox with reply sync on, with the senders that set it', () => {
    const pool = [
      { ...ok, emailAddress: 'chui@thejobshelpers.com', replyTo: ' chui@thejobhelpers.com ' },
      { ...off, emailAddress: 'sam@thejobshelpers.com', replyTo: 'CHUI@thejobhelpers.com' },
      { ...ok, emailAddress: 'lee@acme.test', replyTo: 'off@acme.test' },
    ];
    expect(unreadReplyTos(pool, [...pool, off])).toEqual([
      { address: 'chui@thejobhelpers.com', senders: ['chui@thejobshelpers.com', 'sam@thejobshelpers.com'] },
      { address: 'off@acme.test', senders: ['lee@acme.test'] },
    ]);
  });

  it('leaves out a Reply-To mailbox with reply sync on (even pending or failing), and a sender with no other Reply-To', () => {
    const pool = [
      { ...off, emailAddress: 'a@acme.test', replyTo: 'OK@acme.test' },
      { ...off, emailAddress: 'b@acme.test', replyTo: 'waiting@acme.test' },
      { ...off, emailAddress: 'c@acme.test', replyTo: 'failing@acme.test' },
      { ...off, emailAddress: 'd@acme.test', replyTo: 'D@acme.test' },
      off,
    ];
    expect(unreadReplyTos(pool, [...pool, ok, waiting, failing])).toEqual([]);
  });

  it('says where the replies go, or nothing when every Reply-To is read', () => {
    expect(unreadReplyToNote([])).toBeNull();
    expect(unreadReplyToNote([
      { address: 'chui@thejobhelpers.com', senders: ['chui@thejobshelpers.com', 'sam@thejobshelpers.com'] },
      { address: 'help@acme.test', senders: [] },
    ])).toBe(
      'Replies to emails from chui@thejobshelpers.com, sam@thejobshelpers.com go to the Reply-To address chui@thejobhelpers.com, which is not a mailbox in ArcReach with reply sync on. '
      + 'Replies to emails go to the Reply-To address help@acme.test, which is not a mailbox in ArcReach with reply sync on.',
    );
  });

  it("gives a mailbox's Reply-To, trimmed, only when it is another address, as the campaign's Senders tab names it", () => {
    expect(otherReplyTo({ emailAddress: 'chui@thejobshelpers.com', replyTo: ' chui@thejobhelpers.com ' })).toBe('chui@thejobhelpers.com');
    expect(otherReplyTo({ emailAddress: 'chui@thejobshelpers.com', replyTo: ' CHUI@thejobshelpers.com' })).toBeNull();
    expect(otherReplyTo({ emailAddress: 'chui@thejobshelpers.com', replyTo: '  ' })).toBeNull();
    expect(otherReplyTo({ emailAddress: 'chui@thejobshelpers.com', replyTo: null })).toBeNull();
  });
});

describe('replyCountUnknown (stats A11)', () => {
  it('is unknown, not 0, only while reply sync is off on every mailbox that receives the replies', () => {
    expect(replyCountUnknown('off', 0)).toBe(true);
    expect(replyCountUnknown('off', undefined)).toBe(true);
    // Reply sync is on: a 0 is a measurement, even before the first sync or while it fails.
    for (const state of ['ok', 'waiting', 'failing'] as const) expect(replyCountUnknown(state, 0)).toBe(false);
    // The mailboxes did not load, so nothing says the count is unknown.
    expect(replyCountUnknown(null, 0)).toBe(false);
  });

  it('still counts the replies recorded before reply sync was turned off', () => {
    expect(replyCountUnknown('off', 3)).toBe(false);
  });

  it("gives the campaign page's state for a campaign whose only mailbox has no IMAP details", () => {
    const sender = { emailAddress: 'steve@acme.test', status: 'Active', imapHost: null, imapPort: null, imapUser: null, imapPass: null };
    expect(replyCountUnknown(replySyncState([sender]), 0)).toBe(true);
    expect(replyCountUnknown(replySyncState([{ ...sender, imapHost: 'imap.gmail.com', imapPort: 993, imapUser: 'steve@acme.test', imapPass: '********' }]), 0)).toBe(false);
  });
});

describe("mailboxRepliesFigure: the Accounts page's Replies tile (stats A12)", () => {
  const imap = { status: 'Active', imapHost: 'imap.example.com', imapPort: 993, imapUser: 'u', imapPass: '********' };
  /** sales@acme.test: reply sync works, 8 campaign emails sent, 1 reply. */
  const sales = { ...imap, emailAddress: 'sales@acme.test', imapLastSyncAt: '2026-09-30T08:00:00Z', sentTotal: 8, replies: 1, repliesPer100Sent: 12.5 };

  it('gives replies per 100 emails sent while reply sync works, the singular for exactly 1', () => {
    expect(mailboxRepliesFigure(sales, [sales])).toEqual({ count: 1, sub: '12.5 replies per 100 emails sent', caveat: null });
    expect(mailboxRepliesFigure({ ...sales, sentTotal: 100, repliesPer100Sent: 1 }).sub).toBe('1 reply per 100 emails sent');
    // A measured 0: emails were sent and replies are read.
    expect(mailboxRepliesFigure({ ...sales, replies: 0, repliesPer100Sent: 0 }).sub).toBe('0 replies per 100 emails sent');
  });

  it('says no email was sent rather than 0 per 100 when the mailbox sent none', () => {
    // A mailbox kept as a Reply-To inbox for a sender that is not listed (another user's).
    expect(mailboxRepliesFigure({ ...sales, sentTotal: 0, replies: 120, repliesPer100Sent: null })).toEqual({
      count: 120, sub: 'No campaign emails sent from this mailbox', caveat: null,
    });
  });

  it('gives the reply-sync state in place of the figure while sync is pending, failing or off, as the campaign tile does', () => {
    const waiting = { ...sales, imapLastSyncAt: null, replies: 0, repliesPer100Sent: 0 };
    expect(mailboxRepliesFigure(waiting)).toEqual({
      count: 0, sub: 'Reply sync pending',
      caveat: 'This mailbox has not finished a reply sync yet, so replies to it may be missing from this count.',
    });
    expect(mailboxRepliesFigure({ ...sales, imapLastSyncError: 'Timed out' })).toEqual({
      count: 1, sub: 'Reply sync failing',
      caveat: 'Reply sync is failing on this mailbox, so replies to it may be missing from this count.',
    });
    const off = { ...sales, imapHost: null, imapLastSyncAt: null };
    // None recorded: the count is unknown, not 0.
    expect(mailboxRepliesFigure({ ...off, replies: 0, repliesPer100Sent: 0 })).toEqual({ count: null, sub: 'Reply sync off', caveat: null });
    // Recorded before sync was turned off: still a count, which may be short.
    expect(mailboxRepliesFigure(off)).toEqual({
      count: 1, sub: 'Reply sync off',
      caveat: 'Reply sync is off on this mailbox, so replies to it are not read and may be missing from this count.',
    });
  });

  it("names the mailboxes it is the Reply-To of instead of a figure per 100 of its own emails", () => {
    const a = { emailAddress: 'a@acme.test', replyTo: ' SALES@acme.test ' };
    const b = { emailAddress: 'b@acme.test', replyTo: 'sales@acme.test' };
    const other = { emailAddress: 'c@acme.test', replyTo: 'inbox@acme.test' };
    expect(mailboxRepliesFigure(sales, [sales, a, b, other])).toEqual({
      count: 1, sub: 'Reply-To for 2 mailboxes',
      caveat: 'This mailbox is the Reply-To address of a@acme.test, b@acme.test, so its count includes replies to their emails.',
    });
    // Its own address as its Reply-To changes nothing.
    const self = { ...sales, replyTo: 'Sales@acme.test' };
    expect(mailboxRepliesFigure(self, [self])).toEqual({ count: 1, sub: '12.5 replies per 100 emails sent', caveat: null });
  });

  it('says where replies go when its Reply-To is another address, whatever its own reply sync', () => {
    const elsewhere = { ...sales, replyTo: 'inbox@acme.test ', replies: 0, repliesPer100Sent: 0 };
    const note = "Replies to this mailbox's emails go to its Reply-To address, inbox@acme.test, so they are not counted here.";
    expect(mailboxRepliesFigure(elsewhere)).toEqual({ count: 0, sub: 'Replies go to inbox@acme.test', caveat: note });
    // Its own reply sync off: the few replies sent to it directly are unknown too.
    expect(mailboxRepliesFigure({ ...elsewhere, imapHost: null })).toEqual({ count: null, sub: 'Replies go to inbox@acme.test', caveat: note });
  });
});
