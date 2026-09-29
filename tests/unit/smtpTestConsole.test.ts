import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('../../lib/db', () => ({
  prisma: {
    globalSettings: { findUnique: vi.fn(), findFirst: vi.fn() },
  },
}));

vi.mock('../../lib/session', () => ({
  getSession: vi.fn(),
}));

vi.mock('nodemailer', () => ({
  default: { createTransport: vi.fn() },
}));

import nodemailer from 'nodemailer';
import { getSession } from '../../lib/session';
import { POST } from '../../app/api/settings/test-smtp/route';

const mockedSession = vi.mocked(getSession);
const mockedCreateTransport = vi.mocked(nodemailer.createTransport);

const ADMIN = { id: 'admin-1', name: 'Admin', email: 'admin@example.com', role: 'ADMIN' as const };

function testSmtp() {
  return POST(new NextRequest('http://localhost/api/settings/test-smtp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ smtpHost: 'smtp.acme.test', smtpPort: '587', smtpUser: 'user', smtpPass: 'secret' }),
  }));
}

/** Check marks, crosses and emoji: the console must be plain text. */
const SYMBOLS = /[✓✔✗✘]|\p{Extended_Pictographic}/u;

beforeEach(() => {
  vi.clearAllMocks();
  mockedSession.mockResolvedValue(ADMIN);
});

describe('POST /api/settings/test-smtp console lines (L3)', () => {
  it('ends a passing check with a plain [SMTP OK] line the settings page highlights', async () => {
    mockedCreateTransport.mockReturnValue({ verify: vi.fn().mockResolvedValue(true) } as any);

    const data = await (await testSmtp()).json();
    expect(data.success).toBe(true);
    expect(data.logs.at(-1)).toBe('[SMTP OK] Connection testing successfully completed! Ready for deliverability.');
    expect(data.logs.some((line: string) => SYMBOLS.test(line))).toBe(false);
  });

  it('ends a failing check with a plain [SMTP FAILED] line', async () => {
    mockedCreateTransport.mockReturnValue({ verify: vi.fn().mockRejectedValue(new Error('Invalid login')) } as any);

    const data = await (await testSmtp()).json();
    expect(data.success).toBe(false);
    expect(data.logs.at(-1)).toBe('[SMTP FAILED] Connection testing failed. Please check host server hostname.');
    expect(data.logs.some((line: string) => SYMBOLS.test(line))).toBe(false);
  });
});
