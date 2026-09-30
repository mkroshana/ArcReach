import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('../../lib/db', () => ({
  db: { createAccount: vi.fn() },
  prisma: { globalSettings: { findUnique: vi.fn(), findFirst: vi.fn() } },
}));

vi.mock('../../lib/session', () => ({
  getSession: vi.fn(),
}));

import { db, prisma } from '../../lib/db';
import { getSession } from '../../lib/session';
import { MASKED_SECRET, decryptSecret } from '../../lib/secrets';
import { POST as postAccount } from '../../app/api/accounts/route';

const mockedDb = db as any;
const mockedPrisma = prisma as any;

const USER = { id: 'user-1', name: 'User', email: 'user@example.com', role: 'USER' as const };

function useSettings(settings: Record<string, unknown> | null) {
  mockedPrisma.globalSettings.findUnique.mockResolvedValue(settings);
  mockedPrisma.globalSettings.findFirst.mockResolvedValue(settings);
}

const connect = (emailAddress: unknown) =>
  postAccount(
    new NextRequest('http://localhost/api/accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ emailAddress, provider: 'Google Workspace', name: 'Sales' }),
    })
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue(USER);
  useSettings({ id: 'global', activeProvider: 'AZURE', azureSenderDomains: ['acme.test', 'Outbound.Acme.io'] });
  mockedDb.createAccount.mockImplementation(async (data: any) => ({ id: 'mb-1', ...data }));
});

describe('POST /api/accounts accepts only a sender address on a verified Azure domain (H9)', () => {
  it('refuses an address on an unverified domain with 400 naming the verified domains, and saves nothing', async () => {
    const res = await connect('sales@gmail.com');

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Sender domain "gmail.com" is not in the verified Azure sender domains list. Verified domains: acme.test, outbound.acme.io.',
      verifiedDomains: ['acme.test', 'outbound.acme.io'],
    });
    expect(mockedDb.createAccount).not.toHaveBeenCalled();
  });

  it('refuses a subdomain of a verified domain, which Azure would also refuse', async () => {
    const res = await connect('sales@mail.acme.test');

    expect(res.status).toBe(400);
    expect(mockedDb.createAccount).not.toHaveBeenCalled();
  });

  it('refuses a value that is not an address, even one ending in a verified domain', async () => {
    for (const emailAddress of ['sales', 42, 'sales@acme.test@evil.com', '@acme.test']) {
      const res = await connect(emailAddress);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/is not a valid address\. Verified domains: acme\.test, outbound\.acme\.io\.$/);
    }
    expect(mockedDb.createAccount).not.toHaveBeenCalled();
  });

  it('refuses every address while no verified domain is configured', async () => {
    useSettings(null);

    const res = await connect('sales@acme.test');

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Sender domain "acme.test" is not in the verified Azure sender domains list. Verified domains: none yet (an admin must add one in Settings).',
      verifiedDomains: [],
    });
    expect(mockedDb.createAccount).not.toHaveBeenCalled();
  });

  it('saves an address on a verified domain, whatever its case', async () => {
    const res = await connect('Sales@Outbound.ACME.io');

    expect(res.status).toBe(200);
    expect(mockedDb.createAccount).toHaveBeenCalledTimes(1);
    expect(mockedDb.createAccount.mock.calls[0][0]).toMatchObject({ emailAddress: 'Sales@Outbound.ACME.io', userId: 'user-1' });
  });
});

describe('POST /api/accounts saves no per-mailbox minute or hour limit (M13)', () => {
  it('ignores minuteLimit and hourlyLimit, since those limits are global, and keeps the daily limit', async () => {
    const res = await postAccount(
      new NextRequest('http://localhost/api/accounts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ emailAddress: 'sales@acme.test', provider: 'Google Workspace', name: 'Sales', minuteLimit: 2, hourlyLimit: 40, dailyLimit: 300 }),
      })
    );

    expect(res.status).toBe(200);
    const saved = mockedDb.createAccount.mock.calls[0][0];
    expect(saved).not.toHaveProperty('minuteLimit');
    expect(saved).not.toHaveProperty('hourlyLimit');
    expect(saved.dailyLimit).toBe(300);
  });
});

describe('POST /api/accounts saves no SMTP details, since Azure sends every email (L45)', () => {
  it('ignores SMTP fields, saves the IMAP details with the password encrypted and returns it masked', async () => {
    const res = await postAccount(
      new NextRequest('http://localhost/api/accounts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          emailAddress: 'sales@acme.test', provider: 'Google Workspace', name: 'Sales', dailyLimit: 300,
          smtpHost: 'smtp.acme.test', smtpPort: 587, smtpUser: 'sales@acme.test', smtpPass: 'smtp-secret',
          imapHost: 'imap.acme.test', imapPort: 993, imapUser: 'sales@acme.test', imapPass: 'imap-secret',
        }),
      })
    );

    expect(res.status).toBe(200);
    const saved = mockedDb.createAccount.mock.calls[0][0];
    for (const field of ['smtpHost', 'smtpPort', 'smtpUser', 'smtpPass', 'dailyMax']) expect(saved).not.toHaveProperty(field);
    expect(saved).toMatchObject({ dailyLimit: 300, imapHost: 'imap.acme.test', imapPort: 993, imapUser: 'sales@acme.test' });
    expect(decryptSecret(saved.imapPass)).toBe('imap-secret');

    const body = await res.json();
    expect(body).not.toHaveProperty('smtpPass');
    expect(body.imapPass).toBe(MASKED_SECRET);
    expect(JSON.stringify(body)).not.toContain('secret');
  });
});
