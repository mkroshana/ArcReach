import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('../../lib/db', () => ({
  prisma: {
    campaign: { updateMany: vi.fn(), findUnique: vi.fn(), findMany: vi.fn() },
    campaignEnrollment: { findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    emailDispatch: { create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), findFirst: vi.fn(), count: vi.fn() },
    globalSettings: { findUnique: vi.fn(), findFirst: vi.fn() },
    lead: { findUnique: vi.fn() },
    senderAccount: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    inboundResponse: { findFirst: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock('../../lib/session', () => ({
  getSession: vi.fn(),
}));

vi.mock('../../lib/emailProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/emailProvider')>()),
  sendMessage: vi.fn(),
}));

import { prisma } from '../../lib/db';
import { getSession } from '../../lib/session';
import { sendMessage } from '../../lib/emailProvider';
import { processDueEmails } from '../../lib/sendEngine';
import { POST as postRun } from '../../app/api/campaigns/[id]/run/route';
import { POST as postUniboxReply } from '../../app/api/unibox/reply/route';
import { POST as postTestEmail } from '../../app/api/send-email/test/route';

const mockedPrisma = prisma as any;
const mockedSession = vi.mocked(getSession);
const mockedSend = vi.mocked(sendMessage);

const ADMIN = { id: 'admin-1', name: 'Admin', email: 'admin@example.com', role: 'ADMIN' as const };

const AZURE_SETTINGS = { id: 'global', activeProvider: 'AZURE', azureConnString: 'enc:v1:conn', azureSenderDomains: ['acme.test'] };

/** Every way sending is off: no row, DISABLED or the retired MOCK value (even with Azure credentials saved), or Azure half set up. */
const DISABLED_SETTINGS: Array<[string, Record<string, unknown> | null]> = [
  ['no settings row', null],
  ['DISABLED', { ...AZURE_SETTINGS, activeProvider: 'DISABLED' }],
  ['legacy MOCK', { ...AZURE_SETTINGS, activeProvider: 'MOCK' }],
  ['AZURE without a connection string', { ...AZURE_SETTINGS, azureConnString: null }],
  ['AZURE without verified domains', { ...AZURE_SETTINGS, azureSenderDomains: [] }],
];

const SENDER = {
  id: 'mb-1', userId: 'admin-1', emailAddress: 'one@acme.test', name: 'One', replyTo: null,
  warmupEnabled: false, warmupStartedAt: null, dailyLimit: 100, warmupLimit: 10, warmupRamp: 5,
};

const CAMPAIGN = {
  id: 'cmp-1', userId: 'admin-1', name: 'Launch', status: 'Active', timezone: 'UTC', sendSchedule: null,
  trackOpens: false, trackClicks: false, senderAccountId: 'mb-1', senderAccount: SENDER, senders: [],
  steps: [{ stepOrder: 1, subject: 'Hello', body: 'Hi there', waitDays: 0 }],
};

const ENROLLMENT = {
  id: 'enr-1', campaignId: 'cmp-1', currentSequenceStep: 1, retryCount: 0,
  lead: { id: 'lead-1', email: 'lead@prospect.test', name: 'Lead' },
};

function useSettings(settings: Record<string, unknown> | null) {
  mockedPrisma.globalSettings.findUnique.mockResolvedValue(settings);
  mockedPrisma.globalSettings.findFirst.mockResolvedValue(settings);
}

function makeReq(path: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Nothing that records a send or moves an enrollment may have run. */
function expectNothingRecorded() {
  expect(mockedSend).not.toHaveBeenCalled();
  expect(mockedPrisma.emailDispatch.create).not.toHaveBeenCalled();
  expect(mockedPrisma.emailDispatch.update).not.toHaveBeenCalled();
  expect(mockedPrisma.emailDispatch.updateMany).not.toHaveBeenCalled();
  expect(mockedPrisma.campaignEnrollment.update).not.toHaveBeenCalled();
  expect(mockedPrisma.campaignEnrollment.updateMany).not.toHaveBeenCalled();
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  mockedSession.mockResolvedValue(ADMIN);
  mockedSend.mockResolvedValue({ providerMessageId: 'provider-msg-1' });
  mockedPrisma.campaign.updateMany.mockResolvedValue({ count: 0 });
  mockedPrisma.campaign.findUnique.mockResolvedValue(CAMPAIGN);
  mockedPrisma.campaign.findMany.mockResolvedValue([CAMPAIGN]);
  mockedPrisma.campaignEnrollment.findMany.mockResolvedValue([ENROLLMENT]);
  mockedPrisma.campaignEnrollment.updateMany.mockResolvedValue({ count: 1 });
  mockedPrisma.campaignEnrollment.findFirst.mockResolvedValue({ id: 'enr-1' });
  mockedPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockedPrisma) => unknown) => fn(mockedPrisma));
  mockedPrisma.emailDispatch.updateMany.mockResolvedValue({ count: 1 });
  mockedPrisma.emailDispatch.count.mockResolvedValue(0);
  mockedPrisma.emailDispatch.findFirst.mockResolvedValue(null);
  mockedPrisma.emailDispatch.create.mockImplementation(async ({ data }: any) => ({ id: 'dispatch-1', ...data }));
  mockedPrisma.senderAccount.findUnique.mockResolvedValue(SENDER);
  mockedPrisma.lead.findUnique.mockResolvedValue({ id: 'lead-1', email: 'lead@prospect.test', name: 'Lead' });
  mockedPrisma.inboundResponse.findFirst.mockResolvedValue({ id: 'in-1', campaignId: 'cmp-1' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('processDueEmails refuses to send unless Azure is configured (H1)', () => {
  it.each(DISABLED_SETTINGS)('with %s it logs one warning and leaves every enrollment where it was', async (_label, settings) => {
    useSettings(settings);

    await processDueEmails();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('Sending is disabled.');
    expect(mockedPrisma.campaignEnrollment.findMany).not.toHaveBeenCalled();
    expectNothingRecorded();
  });

  it('sends and advances the enrollment when Azure is configured', async () => {
    useSettings(AZURE_SETTINGS);

    await processDueEmails();

    expect(warn).not.toHaveBeenCalled();
    expect(mockedSend).toHaveBeenCalledTimes(1);
    expect(mockedPrisma.emailDispatch.create).toHaveBeenCalledTimes(1);
    expect(mockedPrisma.campaignEnrollment.updateMany).toHaveBeenCalledWith({
      where: { id: 'enr-1' },
      data: { status: 'Completed', nextActionDate: null, quotaFailures: 0, claimToken: null, claimedAt: null },
    });
  });
});

describe('send routes return 409 unless Azure is configured (H1)', () => {
  const run = () => postRun(makeReq('/api/campaigns/cmp-1/run', {}), { params: Promise.resolve({ id: 'cmp-1' }) });
  const reply = () => postUniboxReply(makeReq('/api/unibox/reply', { leadId: 'lead-1', subject: 'Re: Hello', body: 'Thanks!', senderAccountId: 'mb-1' }));
  const test = () => postTestEmail(makeReq('/api/send-email/test', { senderAccountId: 'mb-1' }));

  it.each(DISABLED_SETTINGS)('with %s every route refuses before recording anything', async (_label, settings) => {
    useSettings(settings);

    for (const call of [run, reply, test]) {
      const res = await call();
      expect(res.status).toBe(409);
      expect((await res.json()).error).toMatch(/^Sending is disabled\./);
    }
    expect(mockedPrisma.campaignEnrollment.findMany).not.toHaveBeenCalled();
    expectNothingRecorded();
  });

  it('lets the manual run queue leads once Azure is configured, leaving the send to the worker', async () => {
    useSettings(AZURE_SETTINGS);

    const res = await run();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ queued: 1 });
    expect(mockedPrisma.campaignEnrollment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { nextActionDate: expect.any(Date) } }),
    );
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it('lets the Unibox reply and test send through once Azure is configured', async () => {
    useSettings(AZURE_SETTINGS);

    for (const call of [reply, test]) {
      expect((await call()).status).toBe(200);
    }
    expect(mockedSend).toHaveBeenCalledTimes(2);
  });
});

describe('POST /api/send-email/test result the Accounts page shows (L22)', () => {
  const test = () => postTestEmail(makeReq('/api/send-email/test', { senderAccountId: 'mb-1' }));

  it('reports success only after Azure accepts the send, naming Azure and the recipient', async () => {
    useSettings(AZURE_SETTINGS);

    const res = await test();
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.message).toBe('Test email successfully sent via Azure Communication Services to admin@example.com.');
    expect(mockedSend).toHaveBeenCalledTimes(1);
  });

  it('returns 409 with success false and the reason when sending is disabled, so the page warns instead of confirming', async () => {
    useSettings({ ...AZURE_SETTINGS, activeProvider: 'DISABLED' });

    const res = await test();
    const data = await res.json();
    expect(res.status).toBe(409);
    expect(data.success).toBe(false);
    expect(data.message).toBeUndefined();
    expect(data.error).toBe('Sending is disabled. An admin must select Azure Communication Services as the delivery provider in Settings.');
    expect(mockedSend).not.toHaveBeenCalled();
  });
});
