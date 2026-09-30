import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../lib/db', () => ({
  prisma: {
    user: { findFirst: vi.fn() },
    senderAccount: { count: vi.fn() },
    campaign: { count: vi.fn(), findMany: vi.fn() },
    lead: { count: vi.fn() },
    globalSettings: { findUnique: vi.fn(), findFirst: vi.fn() },
    workerLease: { findUnique: vi.fn() },
  },
}));

vi.mock('../../lib/session', () => ({
  getSession: vi.fn(),
}));

import { prisma } from '../../lib/db';
import { getSession } from '../../lib/session';
import { encryptSecret } from '../../lib/secrets';
import { SEND_WORKER_LEASE } from '../../lib/workerLease';
import {
  WORKER_STALL_MS, deliveryStatusText, timeAgo, workerStatus, workerStatusText,
} from '../../lib/systemStatus';
import { GET } from '../../app/api/system-status/route';
import { countRows, matchesWhere } from './helpers/prismaWhere';

const mockedPrisma = prisma as any;
const mockedSession = vi.mocked(getSession);

const ADMIN = { id: 'admin-1', name: 'Admin', email: 'admin@example.com', role: 'ADMIN' as const };
const USER = { id: 'user-1', name: 'User', email: 'user@example.com', role: 'USER' as const };

const NOW = new Date('2026-09-30T12:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const MINUTE = 60_000;

const CONN_STRING = 'endpoint=https://arcreach.europe.communication.azure.com/;accesskey=c2VjcmV0LWtleQ==';

/** Azure selected with an encrypted connection string that decrypts and parses, and one verified domain. */
const AZURE = {
  id: 'global',
  activeProvider: 'AZURE',
  azureConnString: encryptSecret(CONN_STRING),
  azureSenderDomains: ['acme.test'],
  smtpHost: null, smtpUser: null, smtpPass: null,
};

/** The fake SMTP values the first GET /api/settings used to seed. */
const SEEDED_SMTP = { smtpHost: 'smtp.mailgun.org', smtpPort: 587, smtpUser: 'postmaster@sandbox.arcreach.com', smtpPass: '•••••' };

let campaigns: any[];
let senderAccounts: any[];

function useSettings(settings: Record<string, unknown> | null) {
  mockedPrisma.globalSettings.findUnique.mockResolvedValue(settings);
  mockedPrisma.globalSettings.findFirst.mockResolvedValue(settings);
}

function useLease(lease: Record<string, unknown> | null) {
  mockedPrisma.workerLease.findUnique.mockResolvedValue(
    lease && { name: SEND_WORKER_LEASE, holderId: 'worker-a', lastTickAt: null, lastSuccessAt: null, lastError: null, ...lease },
  );
}

/** A lease the worker renewed a moment ago, so it is held. */
const held = (heartbeat: Record<string, unknown> = {}) => ({ expiresAt: new Date(NOW.getTime() + 90_000), ...heartbeat });

async function status() {
  const res = await GET();
  expect(res.status).toBe(200);
  return res.json();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  campaigns = [];
  senderAccounts = [];
  mockedSession.mockResolvedValue(ADMIN);
  mockedPrisma.user.findFirst.mockResolvedValue({ id: 'admin-1' });
  mockedPrisma.senderAccount.count.mockImplementation(async ({ where }: any) => countRows(senderAccounts, where));
  mockedPrisma.campaign.count.mockImplementation(async ({ where }: any) => countRows(campaigns, where));
  mockedPrisma.campaign.findMany.mockImplementation(async ({ where, select, take }: any) =>
    campaigns
      .filter((c) => matchesWhere(c, where))
      .slice(0, take)
      .map((c) => Object.fromEntries(Object.keys(select).map((key) => [key, c[key]]))),
  );
  mockedPrisma.lead.count.mockResolvedValue(0);
  useSettings(AZURE);
  useLease(held({ lastTickAt: ago(MINUTE), lastSuccessAt: ago(MINUTE - 2000) }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('GET /api/system-status reads Azure from the decrypted settings and never probes it (M16)', () => {
  it('reports CONFIGURED, not online, for a connection string that decrypts and parses, without any network call', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const body = await status();

    expect(body).toMatchObject({ azureStatus: 'CONFIGURED', sendingProblem: null, activeProvider: 'AZURE' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reports UNCONFIGURED with the reason when the saved connection string cannot be decrypted', async () => {
    const [iv] = encryptSecret(CONN_STRING).slice('enc:v1:'.length).split(':');
    useSettings({ ...AZURE, azureConnString: `enc:v1:${iv}:${Buffer.alloc(40, 7).toString('base64')}` });

    const body = await status();

    expect(body.azureStatus).toBe('UNCONFIGURED');
    expect(body.sendingProblem).toContain('could not be decrypted');
    expect(body.deliveryStatus).toBe('DISABLED');
  });

  it('reports UNCONFIGURED when the decrypted value is not an ACS connection string, without echoing it', async () => {
    useSettings({ ...AZURE, azureConnString: encryptSecret('https://arcreach.europe.communication.azure.com/ key=hunter2') });

    const body = await status();

    expect(body.azureStatus).toBe('UNCONFIGURED');
    expect(body.sendingProblem).toContain('is not valid');
    expect(body.sendingProblem).not.toContain('hunter2');
  });

  it('reports UNCONFIGURED without a connection string or verified domain, and DISABLED when Azure is not selected', async () => {
    useSettings({ ...AZURE, azureSenderDomains: [] });
    expect(await status()).toMatchObject({ azureStatus: 'UNCONFIGURED', deliveryStatus: 'DISABLED' });

    useSettings({ ...AZURE, azureConnString: null });
    expect(await status()).toMatchObject({ azureStatus: 'UNCONFIGURED', deliveryStatus: 'DISABLED' });

    useSettings({ ...AZURE, activeProvider: 'DISABLED' });
    const body = await status();
    expect(body).toMatchObject({ azureStatus: 'DISABLED', deliveryStatus: 'DISABLED' });
    expect(body.sendingProblem).toMatch(/^Sending is disabled\./);
  });
});

describe('GET /api/system-status derives delivery from the worker heartbeat and Azure, not counts or SMTP (M17)', () => {
  it('reports sending DISABLED with seeded SMTP settings, mailboxes and Active campaigns, and no smtpConfigured', async () => {
    useSettings({ ...AZURE, ...SEEDED_SMTP, activeProvider: 'DISABLED' });
    senderAccounts = [{ id: 'mb-1', userId: 'admin-1' }];
    campaigns = [{ id: 'cmp-1', userId: 'admin-1', name: 'Launch', status: 'Active' }];

    const body = await status();

    expect(body).toMatchObject({ deliveryStatus: 'DISABLED', workerStatus: 'RUNNING', accountsCount: 1, activeCampaignsCount: 1 });
    expect(body).not.toHaveProperty('smtpConfigured');
  });

  it('reports the worker NOT_RUNNING when no process has taken the lease, whatever the counts', async () => {
    useLease(null);
    senderAccounts = [{ id: 'mb-1', userId: 'admin-1' }];
    campaigns = [{ id: 'cmp-1', userId: 'admin-1', name: 'Launch', status: 'Active' }];

    const body = await status();

    expect(body).toMatchObject({ workerStatus: 'NOT_RUNNING', deliveryStatus: 'NOT_RUNNING', workerHeartbeat: null });
    expect(mockedPrisma.workerLease.findUnique).toHaveBeenCalledWith({ where: { name: SEND_WORKER_LEASE } });
  });

  it('reports the worker NOT_RUNNING once its lease expired, keeping the last cycle time', async () => {
    useLease({ expiresAt: ago(1000), lastTickAt: ago(10 * MINUTE), lastSuccessAt: ago(10 * MINUTE) });

    const body = await status();

    expect(body).toMatchObject({ workerStatus: 'NOT_RUNNING', deliveryStatus: 'NOT_RUNNING' });
    expect(body.workerHeartbeat.lastTickAt).toBe(ago(10 * MINUTE).toISOString());
  });

  it('reports RUNNING while the lease is held and the last send cycle succeeded', async () => {
    const body = await status();

    expect(body).toMatchObject({ workerStatus: 'RUNNING', deliveryStatus: 'RUNNING' });
    expect(body.workerHeartbeat).toEqual({ lastTickAt: ago(MINUTE).toISOString(), lastSuccessAt: ago(MINUTE - 2000).toISOString(), lastError: null });
  });

  it('reports FAILING when the last send cycle threw, showing the error to admins only', async () => {
    useLease(held({ lastTickAt: ago(MINUTE), lastSuccessAt: ago(60 * MINUTE), lastError: 'The column `Campaign.pauseReason` does not exist' }));

    const admin = await status();
    expect(admin).toMatchObject({ workerStatus: 'FAILING', deliveryStatus: 'FAILING' });
    expect(admin.workerHeartbeat.lastError).toContain('pauseReason');

    mockedSession.mockResolvedValue(USER);
    const user = await status();
    expect(user).toMatchObject({ workerStatus: 'FAILING', deliveryStatus: 'FAILING' });
    expect(user.workerHeartbeat.lastError).toBeNull();
  });

  it('reports STALLED when the lease is held but no send cycle has finished for WORKER_STALL_MS', async () => {
    useLease(held({ lastTickAt: ago(WORKER_STALL_MS + 2 * MINUTE), lastSuccessAt: ago(WORKER_STALL_MS + MINUTE) }));

    expect(await status()).toMatchObject({ workerStatus: 'STALLED', deliveryStatus: 'STALLED' });
  });
});

describe('GET /api/system-status lists campaigns paused for setup problems (M17)', () => {
  beforeEach(() => {
    const pausedUntil = new Date(NOW.getTime() + 30 * MINUTE);
    campaigns = [
      { id: 'cmp-config', userId: 'user-1', name: 'Refused Key', status: 'Paused', pauseReason: 'config', pausedUntil },
      { id: 'cmp-systemic', userId: 'admin-1', name: 'No Owned Sender', status: 'Paused', pauseReason: 'systemic', pausedUntil },
      { id: 'cmp-quota', userId: 'user-1', name: 'Quota', status: 'Paused', pauseReason: 'quota', pausedUntil },
      { id: 'cmp-user', userId: 'user-1', name: 'Held', status: 'Paused', pauseReason: 'user', pausedUntil: null },
      { id: 'cmp-active', userId: 'user-1', name: 'Running', status: 'Active', pauseReason: null, pausedUntil: null },
    ];
  });

  it('lists every config and systemic pause for an admin, not quota or user pauses', async () => {
    const body = await status();

    expect(body.setupPausedCampaigns.map((c: any) => c.id)).toEqual(['cmp-config', 'cmp-systemic']);
    expect(body.setupPausedCampaigns[0]).toEqual({
      id: 'cmp-config', name: 'Refused Key', status: 'Paused', pauseReason: 'config', pausedUntil: new Date(NOW.getTime() + 30 * MINUTE).toISOString(),
    });
    expect(body.setupPausedCount).toBe(2);
  });

  it('lists only the caller\'s own campaigns for a non-admin', async () => {
    mockedSession.mockResolvedValue(USER);

    const body = await status();

    expect(body.setupPausedCampaigns.map((c: any) => c.id)).toEqual(['cmp-config']);
    expect(body.setupPausedCount).toBe(1);
  });

  it('names at most five and counts the rest', async () => {
    campaigns = Array.from({ length: 7 }, (_, i) => ({ id: `cmp-${i}`, userId: 'admin-1', name: `C${i}`, status: 'Paused', pauseReason: 'config', pausedUntil: NOW }));

    const body = await status();

    expect(body.setupPausedCampaigns).toHaveLength(5);
    expect(body.setupPausedCount).toBe(7);
  });
});

describe('system status wording (M16, M17)', () => {
  it('words the worker from its heartbeat', () => {
    const heartbeat = { lastTickAt: ago(3 * MINUTE + 5000), lastSuccessAt: ago(3 * MINUTE), lastError: null };
    expect(workerStatusText('RUNNING', heartbeat, NOW)).toBe('Worker running, last send cycle 3 min ago.');
    expect(workerStatusText('RUNNING', { lastTickAt: null, lastSuccessAt: null, lastError: null }, NOW)).toBe('Worker running, no send cycle finished yet.');
    expect(workerStatusText('FAILING', { ...heartbeat, lastError: 'boom' }, NOW)).toBe('Worker running, but its last send cycle failed: boom');
    expect(workerStatusText('FAILING', heartbeat, NOW)).toBe('Worker running, but its last send cycle failed.');
    expect(workerStatusText('STALLED', { ...heartbeat, lastSuccessAt: ago(2 * 60 * MINUTE) }, NOW)).toContain('its last send cycle finished 2 h ago');
    expect(workerStatusText('NOT_RUNNING', null, NOW)).toMatch(/^Worker not running\. .*SEND_WORKER_ENABLED=true/);
    expect(workerStatusText('NOT_RUNNING', heartbeat, NOW)).toMatch(/^Worker not running \(last send cycle 3 min ago\)\./);
  });

  it('words a DISABLED delivery by why sending is refused', () => {
    expect(deliveryStatusText('DISABLED', 'Sending is disabled. Pick Azure.', null, NOW)).toBe('Sending is disabled. Pick Azure.');
    expect(deliveryStatusText('NOT_RUNNING', null, null, NOW)).toMatch(/^Worker not running/);
  });

  it('derives the worker status from the lease row alone', () => {
    expect(workerStatus(null, NOW)).toBe('NOT_RUNNING');
    expect(workerStatus({ expiresAt: NOW, lastTickAt: null, lastSuccessAt: null, lastError: null }, NOW)).toBe('NOT_RUNNING');
    expect(workerStatus({ ...held(), lastTickAt: null, lastSuccessAt: null, lastError: null }, NOW)).toBe('RUNNING');
    expect(workerStatus({ ...held(), lastTickAt: ago(MINUTE), lastSuccessAt: ago(WORKER_STALL_MS), lastError: null }, NOW)).toBe('RUNNING');
    expect(workerStatus({ ...held(), lastTickAt: ago(MINUTE), lastSuccessAt: ago(WORKER_STALL_MS + 1), lastError: null }, NOW)).toBe('STALLED');
    expect(workerStatus({ ...held(), lastTickAt: ago(MINUTE), lastSuccessAt: ago(WORKER_STALL_MS + 1), lastError: 'x' }, NOW)).toBe('FAILING');
  });

  it('formats elapsed time in the largest whole unit', () => {
    expect(timeAgo(ago(59_000), NOW)).toBe('just now');
    expect(timeAgo(ago(59 * MINUTE), NOW)).toBe('59 min ago');
    expect(timeAgo(ago(23 * 60 * MINUTE), NOW)).toBe('23 h ago');
    expect(timeAgo(ago(24 * 60 * MINUTE), NOW)).toBe('1 day ago');
    expect(timeAgo(ago(3 * 24 * 60 * MINUTE).toISOString(), NOW)).toBe('3 days ago');
  });
});
