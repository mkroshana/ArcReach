import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('../../lib/db', () => ({
  prisma: {
    workerLease: { findUnique: vi.fn() },
    inboundResponse: { findMany: vi.fn() },
    emailDispatch: { findMany: vi.fn() },
    suppressedEmail: { findMany: vi.fn() },
  },
}));

vi.mock('../../lib/session', () => ({
  getSession: vi.fn(),
}));

vi.mock('../../lib/imapService', () => ({
  syncMailboxReplies: vi.fn(),
  getActiveImapAccounts: vi.fn(),
}));

import { prisma } from '../../lib/db';
import { getSession } from '../../lib/session';
import { getActiveImapAccounts, syncMailboxReplies } from '../../lib/imapService';
import { LEASE_HOLDER_ID, SEND_WORKER_LEASE, leaseHeldElsewhere } from '../../lib/workerLease';
import { GET as getUnibox } from '../../app/api/unibox/route';

const mockedPrisma = prisma as any;

const USER = { id: 'user-1', name: 'User', email: 'user@example.com', role: 'USER' as const };
const MAILBOXES = [{ id: 'mbx_1' }, { id: 'mbx_2' }];
const MINUTE = 60 * 1000;

function lease(holderId: string, expiresInMs: number) {
  return { name: SEND_WORKER_LEASE, holderId, expiresAt: new Date(Date.now() + expiresInMs), lastTickAt: null, lastSuccessAt: null, lastError: null };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue(USER);
  vi.mocked(getActiveImapAccounts).mockResolvedValue(MAILBOXES as any);
  vi.mocked(syncMailboxReplies).mockResolvedValue({ success: true, syncedCount: 0 });
  mockedPrisma.inboundResponse.findMany.mockResolvedValue([]);
  mockedPrisma.emailDispatch.findMany.mockResolvedValue([]);
  mockedPrisma.suppressedEmail.findMany.mockResolvedValue([]);
});

describe('GET /api/unibox IMAP sync and the worker lease (M51)', () => {
  it.each(['/api/unibox', '/api/unibox?sync=true'])('leaves %s syncing to the worker while another process holds the lease', async (path) => {
    mockedPrisma.workerLease.findUnique.mockResolvedValue(lease('other-process', MINUTE));

    const res = await getUnibox(new NextRequest(`http://localhost${path}`));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ threads: [], total: 0, unreadCount: 0, nextOffset: null });
    expect(mockedPrisma.workerLease.findUnique).toHaveBeenCalledWith({ where: { name: SEND_WORKER_LEASE } });
    expect(syncMailboxReplies).not.toHaveBeenCalled();
  });

  it.each([
    ['this process holds the lease', () => lease(LEASE_HOLDER_ID, MINUTE)],
    ["another process's lease expired", () => lease('other-process', -MINUTE)],
    ['no process has taken the lease', () => null],
  ])('syncs every mailbox when %s', async (_label, row) => {
    mockedPrisma.workerLease.findUnique.mockResolvedValue(row());

    const res = await getUnibox(new NextRequest('http://localhost/api/unibox?sync=true'));

    expect(res.status).toBe(200);
    expect(vi.mocked(syncMailboxReplies).mock.calls.map(([id]) => id)).toEqual(['mbx_1', 'mbx_2']);
  });

  it('does not read the lease when the caller has no IMAP mailboxes', async () => {
    vi.mocked(getActiveImapAccounts).mockResolvedValue([]);

    const res = await getUnibox(new NextRequest('http://localhost/api/unibox?sync=true'));

    expect(res.status).toBe(200);
    expect(mockedPrisma.workerLease.findUnique).not.toHaveBeenCalled();
    expect(syncMailboxReplies).not.toHaveBeenCalled();
  });

  it('syncs in the background only for the first page of the unsearched list (H35)', async () => {
    mockedPrisma.workerLease.findUnique.mockResolvedValue(null);

    await getUnibox(new NextRequest('http://localhost/api/unibox'));
    expect(vi.mocked(syncMailboxReplies).mock.calls.map(([id]) => id)).toEqual(['mbx_1', 'mbx_2']);

    vi.mocked(syncMailboxReplies).mockClear();
    for (const path of ['/api/unibox?offset=50', '/api/unibox?q=pricing', '/api/unibox?export=replies', '/api/unibox?thread=11111111-2222-3333-4444-555555555555-hello']) {
      const res = await getUnibox(new NextRequest(`http://localhost${path}`));
      expect(res.status).toBe(path.includes('thread=') ? 404 : 200);
    }
    expect(syncMailboxReplies).not.toHaveBeenCalled();
  });
});

describe('leaseHeldElsewhere (M51)', () => {
  it('is true only for a live lease naming another holder', async () => {
    const now = new Date('2026-09-30T12:00:00Z');
    const row = (holderId: string, expiresAt: Date) => ({ name: SEND_WORKER_LEASE, holderId, expiresAt });

    mockedPrisma.workerLease.findUnique.mockResolvedValue(row('other', new Date(now.getTime() + 1)));
    expect(await leaseHeldElsewhere(SEND_WORKER_LEASE, 'me', now)).toBe(true);

    mockedPrisma.workerLease.findUnique.mockResolvedValue(row('other', now));
    expect(await leaseHeldElsewhere(SEND_WORKER_LEASE, 'me', now)).toBe(false);

    mockedPrisma.workerLease.findUnique.mockResolvedValue(row('me', new Date(now.getTime() + MINUTE)));
    expect(await leaseHeldElsewhere(SEND_WORKER_LEASE, 'me', now)).toBe(false);

    mockedPrisma.workerLease.findUnique.mockResolvedValue(null);
    expect(await leaseHeldElsewhere(SEND_WORKER_LEASE, 'me', now)).toBe(false);
  });
});
