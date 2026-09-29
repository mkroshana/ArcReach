import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { NextRequest } from 'next/server';

// Fake IMAP server over a mocked TLS socket; every tls.connect call's options are recorded.
const server = vi.hoisted(() => ({
  connectArgs: [] as any[][],
}));

vi.mock('tls', () => {
  const connect = (...args: any[]) => {
    server.connectArgs.push(args);
    const socket: any = new EventEmitter();
    socket.setTimeout = () => {};
    socket.end = () => setImmediate(() => socket.emit('close'));
    socket.destroy = () => setImmediate(() => socket.emit('close'));
    socket.write = (data: string) => {
      const [tag, verb] = data.trim().split(/\s+/);
      let reply = '';
      if (verb === 'LOGIN') reply = `${tag} OK LOGIN completed\r\n`;
      else if (verb === 'SELECT') reply = `* 0 EXISTS\r\n${tag} OK [READ-WRITE] SELECT completed\r\n`;
      else if (verb === 'SEARCH') reply = `* SEARCH\r\n${tag} OK SEARCH completed\r\n`;
      if (reply) setImmediate(() => socket.emit('data', Buffer.from(reply)));
      return true;
    };
    setImmediate(() => socket.emit('data', Buffer.from('* OK IMAP4rev1 Service Ready\r\n')));
    return socket;
  };
  return { default: { connect }, connect };
});

vi.mock('../../lib/db', () => ({
  db: { createAccount: vi.fn(), getAccounts: vi.fn(), updateAccount: vi.fn() },
  prisma: {
    senderAccount: { findUnique: vi.fn() },
    user: { findUnique: vi.fn() },
    globalSettings: { findUnique: vi.fn(), findFirst: vi.fn() },
  },
}));

vi.mock('../../lib/session', () => ({
  getSession: vi.fn(),
}));

import { db, prisma } from '../../lib/db';
import { getSession } from '../../lib/session';
import { encryptSecret } from '../../lib/secrets';
import { imapTlsOptions, syncMailboxReplies } from '../../lib/imapService';
import { POST as postAccount, PUT as putAccount } from '../../app/api/accounts/route';

const mockedDb = db as any;
const mockedPrisma = prisma as any;

const USER = { id: 'user-1', name: 'User', email: 'user@example.com', role: 'USER' as const };

const MAILBOX = {
  id: 'mbx_1',
  emailAddress: 'sales@acme.test',
  imapHost: 'imap.example.com',
  imapPort: 993,
  imapUser: 'sales@acme.test',
  imapPass: encryptSecret('secret'),
  imapAllowSelfSigned: false,
};

function makeReq(method: 'POST' | 'PUT', body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/accounts', {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('imapTlsOptions (M47)', () => {
  it('verifies the certificate for the host name and sends it as SNI', () => {
    expect(imapTlsOptions('imap.example.com', 993, false)).toEqual({
      host: 'imap.example.com',
      port: 993,
      servername: 'imap.example.com',
      rejectUnauthorized: true,
    });
  });

  it('sends no SNI for an IP address host, which RFC 6066 does not allow, but still verifies', () => {
    for (const host of ['192.0.2.10', '2001:db8::1']) {
      const opts = imapTlsOptions(host, 993, false);
      expect(opts.servername).toBeUndefined();
      expect(opts.rejectUnauthorized).toBe(true);
    }
  });

  it('turns verification off only for a mailbox that opted in to a self-signed certificate', () => {
    expect(imapTlsOptions('imap.example.com', 993, true).rejectUnauthorized).toBe(false);
  });
});

describe('syncMailboxReplies TLS connection (M47)', () => {
  beforeEach(() => {
    server.connectArgs = [];
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('connects with certificate verification on and the host as servername by default', async () => {
    mockedPrisma.senderAccount.findUnique.mockResolvedValue(MAILBOX);

    const result = await syncMailboxReplies('mbx_1');

    expect(result).toEqual({ success: true, syncedCount: 0 });
    expect(server.connectArgs).toHaveLength(1);
    expect(server.connectArgs[0][0]).toEqual({
      host: 'imap.example.com',
      port: 993,
      servername: 'imap.example.com',
      rejectUnauthorized: true,
    });
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('skips verification for an opted-in mailbox and logs that it did', async () => {
    mockedPrisma.senderAccount.findUnique.mockResolvedValue({ ...MAILBOX, imapAllowSelfSigned: true });

    await syncMailboxReplies('mbx_1');

    expect(server.connectArgs[0][0]).toMatchObject({ servername: 'imap.example.com', rejectUnauthorized: false });
    expect(console.warn).toHaveBeenCalledWith(
      '[IMAP Sync] Certificate verification is off for sales@acme.test (Allow Self-Signed Certificate).'
    );
  });
});

describe('Accounts API imapAllowSelfSigned (M47)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSession).mockResolvedValue(USER);
    const settings = { id: 'global', activeProvider: 'AZURE', azureSenderDomains: ['acme.test'] };
    mockedPrisma.globalSettings.findUnique.mockResolvedValue(settings);
    mockedPrisma.globalSettings.findFirst.mockResolvedValue(settings);
    mockedDb.createAccount.mockImplementation(async (data: any) => ({ id: 'mbx_1', ...data }));
    mockedDb.getAccounts.mockResolvedValue([{ id: 'mbx_1' }]);
    mockedDb.updateAccount.mockImplementation(async (id: string, data: any) => ({ id, ...data }));
    mockedPrisma.senderAccount.findUnique.mockResolvedValue(MAILBOX);
  });

  it('creates a mailbox with verification on unless the opt-in is exactly true', async () => {
    const base = { emailAddress: 'sales@acme.test', provider: 'IMAP/SMTP Custom Protocol', imapHost: 'imap.acme.test', imapPort: 993 };

    for (const [sent, stored] of [[undefined, false], ['true', false], [1, false], [true, true]] as const) {
      mockedDb.createAccount.mockClear();
      const res = await postAccount(makeReq('POST', { ...base, imapAllowSelfSigned: sent }));
      expect(res.status).toBe(200);
      expect(mockedDb.createAccount.mock.calls[0][0].imapAllowSelfSigned).toBe(stored);
    }
  });

  it('saves the opt-in from the credentials form and refuses a non-boolean value', async () => {
    const on = await putAccount(makeReq('PUT', { id: 'mbx_1', imapAllowSelfSigned: true }));
    expect(on.status).toBe(200);
    expect(mockedDb.updateAccount).toHaveBeenLastCalledWith('mbx_1', { imapAllowSelfSigned: true });
    expect((await on.json()).imapAllowSelfSigned).toBe(true);

    const bad = await putAccount(makeReq('PUT', { id: 'mbx_1', imapAllowSelfSigned: 'yes' }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe('Field "imapAllowSelfSigned" must be a boolean.');
    expect(mockedDb.updateAccount).toHaveBeenCalledTimes(1);
  });
});
