import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * In-memory campaigns, leads, enrollments and dispatches. The fake models
 * evaluate the where clauses the send engine, the manual run route and
 * lib/sendEligibility build, so the tests check which sends really happen and
 * the rows they leave behind.
 */
const fake = vi.hoisted(() => ({
  campaign: { updateMany: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() },
  campaignEnrollment: { findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  emailDispatch: { create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), findFirst: vi.fn(), count: vi.fn() },
  emailEvent: { create: vi.fn() },
  lead: { update: vi.fn() },
  senderAccount: { update: vi.fn(), updateMany: vi.fn() },
  $transaction: vi.fn(),
}));

vi.mock('../../lib/db', () => ({ prisma: fake }));

vi.mock('../../lib/session', () => ({
  getSession: vi.fn(),
}));

vi.mock('../../lib/settings', () => ({
  getGlobalSettings: vi.fn(),
}));

vi.mock('../../lib/rateLimits', () => ({
  checkGlobalRateLimits: vi.fn(),
}));

vi.mock('../../lib/emailProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/emailProvider')>()),
  sendMessage: vi.fn(),
}));

import { getSession } from '../../lib/session';
import { getGlobalSettings } from '../../lib/settings';
import { checkGlobalRateLimits } from '../../lib/rateLimits';
import { sendMessage } from '../../lib/emailProvider';
import { processDueEmails, BOOKKEEPING_RETRIES } from '../../lib/sendEngine';
import { SEND_CLAIM_TTL_MS, claimEnrollmentForSend, releaseEnrollmentClaim } from '../../lib/sendEligibility';
import { POST as postRun } from '../../app/api/campaigns/[id]/run/route';

const mockedSend = vi.mocked(sendMessage);

type LeadRow = { id: string; email: string; name: string; status: string; validationStatus: string; isArchived: boolean };
type EnrollmentRow = {
  id: string; leadId: string; campaignId: string; status: string; currentSequenceStep: number;
  nextActionDate: Date | null; retryCount: number; lastError: string | null; lastBounceType: string | null;
  claimToken: string | null; claimedAt: Date | null;
};
type DispatchRow = {
  id: string; leadId: string; campaignId: string | null; senderAccountId: string | null; messageId: string;
  stepOrder: number | null; status: string; sentAt: Date; subject?: string; body?: string; operationId?: string | null;
};

const SENDER = {
  id: 'mb-1', userId: 'admin-1', emailAddress: 'one@acme.test', name: 'One', replyTo: null,
  warmupEnabled: false, warmupStartedAt: null, dailyLimit: 100, warmupLimit: 10, warmupRamp: 5,
};

let campaign: any;
let leads: Map<string, LeadRow>;
let enrollments: EnrollmentRow[];
let dispatches: DispatchRow[];
let nextDispatchId = 0;
/** Models written through the $transaction callback's client, in order. */
let txWrites: string[];

const PAST = new Date('2026-01-01T00:00:00Z');

function addLead(id: string) {
  leads.set(id, { id, email: `${id}@prospect.test`, name: 'Lead', status: 'Neutral', validationStatus: 'Valid', isArchived: false });
  enrollments.push({
    id: `enr-${id}`, leadId: id, campaignId: 'cmp-1', status: 'Active', currentSequenceStep: 1,
    nextActionDate: PAST, retryCount: 0, lastError: null, lastBounceType: null, claimToken: null, claimedAt: null,
  });
}

const enrollmentOf = (leadId: string) => enrollments.find((e) => e.leadId === leadId)!;

function addDispatch(row: Partial<DispatchRow> & { status: string }) {
  const dispatch: DispatchRow = {
    id: `dispatch-${++nextDispatchId}`, leadId: 'lead-1', campaignId: 'cmp-1', senderAccountId: 'mb-1',
    messageId: `msg-${nextDispatchId}`, stepOrder: 1, sentAt: new Date(), ...row,
  };
  dispatches.push(dispatch);
  return dispatch;
}

/** Evaluates one Prisma scalar filter; throws on shapes it doesn't model so a changed query can't silently match. */
function matchesValue(value: any, cond: any): boolean {
  if (cond === null || typeof cond !== 'object') return value === cond;
  if ('in' in cond) return cond.in.includes(value);
  if ('notIn' in cond) return !cond.notIn.includes(value);
  if ('not' in cond) return value !== cond.not;
  if ('lt' in cond) return value !== null && value < cond.lt;
  if ('lte' in cond) return value !== null && value <= cond.lte;
  if ('gte' in cond) return value !== null && value >= cond.gte;
  throw new Error(`Unmodelled filter: ${JSON.stringify(cond)}`);
}

function matchesFields(row: any, where: Record<string, any>): boolean {
  return Object.entries(where).every(([key, cond]) => matchesValue(row[key], cond));
}

function matchesEnrollment(e: EnrollmentRow, where: Record<string, any>): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'AND') return cond.every((w: any) => matchesEnrollment(e, w));
    if (key === 'OR') return cond.some((w: any) => matchesEnrollment(e, w));
    if (key === 'campaign') return e.campaignId === campaign.id && matchesFields(campaign, cond);
    if (key === 'lead') return matchesFields(leads.get(e.leadId), cond);
    return matchesValue((e as any)[key], cond);
  });
}

function applyEnrollmentData(e: EnrollmentRow, data: Record<string, any>) {
  for (const [key, value] of Object.entries(data)) {
    (e as any)[key] = value !== null && typeof value === 'object' && 'increment' in value
      ? (e as any)[key] + value.increment
      : value;
  }
}

function makeRunReq(): NextRequest {
  return new NextRequest('http://localhost/api/campaigns/cmp-1/run', { method: 'POST' });
}
const run = () => postRun(makeRunReq(), { params: Promise.resolve({ id: 'cmp-1' }) });

/** Runs a send pass with setTimeout faked, so the bookkeeping retry delays pass at once. */
async function withFakeTimers<T>(pass: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ['setTimeout'] });
  try {
    const pending = pass();
    await vi.runAllTimersAsync();
    return await pending;
  } finally {
    vi.useRealTimers();
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});

  campaign = {
    id: 'cmp-1', userId: 'admin-1', name: 'Launch', status: 'Active', timezone: 'UTC', sendSchedule: null,
    trackOpens: false, trackClicks: false, senderAccountId: 'mb-1', senderAccount: SENDER, senders: [],
    steps: [
      { stepOrder: 1, subject: 'Hello', body: 'Hi there', waitDays: 0 },
      { stepOrder: 2, subject: 'Following up', body: 'Just checking in', waitDays: 3 },
    ],
  };
  leads = new Map();
  enrollments = [];
  dispatches = [];
  nextDispatchId = 0;
  txWrites = [];
  addLead('lead-1');

  vi.mocked(getSession).mockResolvedValue({ id: 'admin-1', name: 'Admin', email: 'admin@example.com', role: 'ADMIN' } as any);
  vi.mocked(getGlobalSettings).mockResolvedValue({
    id: 'global', activeProvider: 'AZURE', azureConnString: 'enc:v1:conn', azureSenderDomains: ['acme.test'],
  } as any);
  vi.mocked(checkGlobalRateLimits).mockResolvedValue({ allowed: true });
  mockedSend.mockResolvedValue({ providerMessageId: 'provider-msg-1' });

  fake.campaign.updateMany.mockResolvedValue({ count: 0 });
  fake.campaign.findUnique.mockImplementation(async () => structuredClone(campaign));
  fake.campaign.findMany.mockImplementation(async () => [structuredClone(campaign)]);
  fake.campaign.update.mockImplementation(async ({ data }: any) => Object.assign(campaign, data));
  fake.campaignEnrollment.findMany.mockImplementation(async ({ where }: any) =>
    enrollments
      .filter((e) => matchesEnrollment(e, where))
      .map((e) => ({ ...structuredClone(e), lead: { ...leads.get(e.leadId)! } })),
  );
  fake.campaignEnrollment.update.mockImplementation(async ({ where, data }: any) => {
    const row = enrollments.find((e) => e.id === where.id)!;
    applyEnrollmentData(row, data);
    return row;
  });
  fake.campaignEnrollment.updateMany.mockImplementation(async ({ where, data }: any) => {
    const hit = enrollments.filter((e) => matchesEnrollment(e, where));
    hit.forEach((e) => applyEnrollmentData(e, data));
    return { count: hit.length };
  });
  fake.emailDispatch.create.mockImplementation(async ({ data }: any) => {
    const row = addDispatch({ ...data, sentAt: new Date() });
    return { ...row };
  });
  fake.emailDispatch.update.mockImplementation(async ({ where, data }: any) =>
    Object.assign(dispatches.find((d) => d.id === where.id)!, data),
  );
  fake.emailDispatch.updateMany.mockImplementation(async ({ where, data }: any) => {
    const hit = dispatches.filter((d) => matchesFields(d, where));
    hit.forEach((d) => Object.assign(d, data));
    return { count: hit.length };
  });
  fake.senderAccount.updateMany.mockResolvedValue({ count: 1 });
  fake.emailDispatch.findFirst.mockImplementation(async ({ where }: any) => {
    const row = dispatches.find((d) => matchesFields(d, where));
    return row ? { id: row.id } : null;
  });
  fake.emailDispatch.count.mockImplementation(async ({ where }: any) =>
    dispatches.filter((d) => matchesFields(d, where)).length,
  );
  fake.$transaction.mockImplementation(async (arg: any) => {
    if (typeof arg !== 'function') return Promise.all(arg);
    const tracked = (model: 'emailDispatch' | 'campaignEnrollment' | 'senderAccount') => ({
      updateMany: (args: unknown) => {
        txWrites.push(model);
        return fake[model].updateMany(args);
      },
    });
    return arg({
      emailDispatch: tracked('emailDispatch'),
      campaignEnrollment: tracked('campaignEnrollment'),
      senderAccount: tracked('senderAccount'),
    });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('claimEnrollmentForSend (C5, H7)', () => {
  const T0 = new Date('2026-09-01T12:00:00Z');
  const at = (ms: number) => new Date(T0.getTime() + ms);

  it('claims an enrollment once, refuses a second claim, and lets a stale claim be taken over', async () => {
    const first = await claimEnrollmentForSend('enr-lead-1', 1, T0);
    expect(first).toEqual(expect.any(String));
    expect(enrollmentOf('lead-1')).toMatchObject({ claimToken: first, claimedAt: T0 });

    expect(await claimEnrollmentForSend('enr-lead-1', 1, at(60_000))).toBeNull();
    expect(await claimEnrollmentForSend('enr-lead-1', 1, at(SEND_CLAIM_TTL_MS))).toBeNull();

    const takeover = await claimEnrollmentForSend('enr-lead-1', 1, at(SEND_CLAIM_TTL_MS + 1));
    expect(takeover).toEqual(expect.any(String));
    expect(takeover).not.toBe(first);

    // The abandoned send's release must not free the new claim.
    await releaseEnrollmentClaim('enr-lead-1', first!);
    expect(enrollmentOf('lead-1').claimToken).toBe(takeover);

    await releaseEnrollmentClaim('enr-lead-1', takeover!);
    expect(enrollmentOf('lead-1')).toMatchObject({ claimToken: null, claimedAt: null });
    expect(await claimEnrollmentForSend('enr-lead-1', 1, at(SEND_CLAIM_TTL_MS + 2))).toEqual(expect.any(String));
  });

  it.each<[string, () => void]>([
    ['the campaign was paused', () => { campaign.status = 'Paused'; }],
    ['a reply paused the enrollment', () => { enrollmentOf('lead-1').status = 'Paused'; }],
    ['the enrollment already moved to the next step', () => { enrollmentOf('lead-1').currentSequenceStep = 2; }],
    ['the lead unsubscribed', () => { leads.get('lead-1')!.status = 'Unsubscribed'; }],
    ['the lead bounced', () => { leads.get('lead-1')!.status = 'Bounced'; }],
    ['the lead was marked Invalid', () => { leads.get('lead-1')!.validationStatus = 'Invalid'; }],
    ['the lead was archived', () => { leads.get('lead-1')!.isArchived = true; }],
  ])('refuses the claim when %s', async (_label, change) => {
    change();

    expect(await claimEnrollmentForSend('enr-lead-1', 1, T0)).toBeNull();
    expect(enrollmentOf('lead-1')).toMatchObject({ claimToken: null, claimedAt: null });
  });
});

describe('processDueEmails claims each send and records it as Sending first (C5, H6, H7)', () => {
  it('sends with the dispatch Sending and the enrollment claimed, then marks it Sent in the transaction that advances and releases', async () => {
    const duringSend: Array<{ dispatchStatus: string; claimToken: string | null }> = [];
    mockedSend.mockImplementation(async () => {
      duringSend.push({ dispatchStatus: dispatches[0].status, claimToken: enrollmentOf('lead-1').claimToken });
      return { providerMessageId: 'provider-msg-1' };
    });

    await processDueEmails();

    expect(mockedSend).toHaveBeenCalledTimes(1);
    expect(duringSend).toEqual([{ dispatchStatus: 'Sending', claimToken: expect.any(String) }]);
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]).toMatchObject({ status: 'Sent', messageId: 'provider-msg-1', stepOrder: 1 });
    expect(enrollmentOf('lead-1')).toMatchObject({ status: 'Active', currentSequenceStep: 2, claimToken: null, claimedAt: null });

    expect(fake.$transaction).toHaveBeenCalledTimes(1);
    expect(txWrites).toEqual(['emailDispatch', 'campaignEnrollment']);
  });

  it.each<[string, () => void]>([
    ['the campaign is paused', () => { campaign.status = 'Paused'; }],
    ['the lead unsubscribes', () => { leads.get('lead-1')!.status = 'Unsubscribed'; }],
    ['a reply pauses the enrollment', () => { enrollmentOf('lead-1').status = 'Paused'; }],
  ])('sends nothing when %s after the batch was loaded', async (_label, change) => {
    const loadBatch = fake.campaignEnrollment.findMany.getMockImplementation()!;
    fake.campaignEnrollment.findMany.mockImplementationOnce(async (args: any) => {
      const batch = await loadBatch(args);
      change();
      return batch;
    });

    await processDueEmails();

    expect(mockedSend).not.toHaveBeenCalled();
    expect(dispatches).toHaveLength(0);
    expect(enrollmentOf('lead-1')).toMatchObject({ currentSequenceStep: 1, claimToken: null });
  });

  it('does not send an enrollment another send path has claimed', async () => {
    const claimedAt = new Date(Date.now() - 60_000);
    Object.assign(enrollmentOf('lead-1'), { claimToken: 'manual-run', claimedAt });

    await processDueEmails();

    expect(mockedSend).not.toHaveBeenCalled();
    expect(dispatches).toHaveLength(0);
    expect(enrollmentOf('lead-1')).toMatchObject({ currentSequenceStep: 1, claimToken: 'manual-run', claimedAt });
  });

  it('leaves a step whose dispatch is still Sending alone instead of sending it again or skipping it', async () => {
    addDispatch({ status: 'Sending', stepOrder: 1 });

    await processDueEmails();

    expect(mockedSend).not.toHaveBeenCalled();
    expect(dispatches).toHaveLength(1);
    expect(enrollmentOf('lead-1')).toMatchObject({ currentSequenceStep: 1, claimToken: null, claimedAt: null });
  });

  it('advances past a step whose dispatch is already Sent without sending it again', async () => {
    addDispatch({ status: 'Sent', stepOrder: 1 });

    await processDueEmails();

    expect(mockedSend).not.toHaveBeenCalled();
    expect(dispatches).toHaveLength(1);
    expect(enrollmentOf('lead-1')).toMatchObject({ currentSequenceStep: 2, claimToken: null, claimedAt: null });
  });

  it('still sends a step whose earlier attempt Failed', async () => {
    addDispatch({ status: 'Failed', stepOrder: 1 });

    await processDueEmails();

    expect(mockedSend).toHaveBeenCalledTimes(1);
    expect(dispatches.map((d) => d.status)).toEqual(['Failed', 'Sent']);
  });

  it('marks a refused send Failed and releases the claim for the retry', async () => {
    mockedSend.mockRejectedValue(new Error('Connection timed out'));

    await processDueEmails();

    expect(dispatches).toHaveLength(1);
    expect(dispatches[0].status).toBe('Failed');
    expect(enrollmentOf('lead-1')).toMatchObject({ currentSequenceStep: 1, retryCount: 1, claimToken: null, claimedAt: null });
    expect(enrollmentOf('lead-1').nextActionDate!.getTime()).toBeGreaterThan(Date.now());
  });

  it('counts sends still in Sending toward the mailbox daily cap', async () => {
    campaign.senderAccount = { ...SENDER, dailyLimit: 1 };
    addDispatch({ status: 'Sending', leadId: 'lead-other', stepOrder: 1 });

    await processDueEmails();

    expect(mockedSend).not.toHaveBeenCalled();
    expect(enrollmentOf('lead-1').nextActionDate!.getTime()).toBeGreaterThan(Date.now());
  });
});

describe('POST /api/campaigns/[id]/run claims each send (C5, H7)', () => {
  it('stops sending as soon as the campaign is paused mid-run', async () => {
    addLead('lead-2');
    mockedSend.mockImplementation(async () => {
      campaign.status = 'Paused';
      return { providerMessageId: 'provider-msg-1' };
    });

    const res = await run();

    expect(res.status).toBe(200);
    expect((await res.json()).dispatchedCount).toBe(1);
    expect(mockedSend).toHaveBeenCalledTimes(1);
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]).toMatchObject({ leadId: 'lead-1', status: 'Sent' });
    expect(enrollmentOf('lead-1')).toMatchObject({ currentSequenceStep: 2, claimToken: null });
    expect(enrollmentOf('lead-2')).toMatchObject({ currentSequenceStep: 1, claimToken: null });
  });

  it('does not send an enrollment the background worker is sending', async () => {
    Object.assign(enrollmentOf('lead-1'), { claimToken: 'worker', claimedAt: new Date() });
    addDispatch({ status: 'Sending', stepOrder: 1 });

    const res = await run();

    expect(res.status).toBe(200);
    expect((await res.json()).dispatchedCount).toBe(0);
    expect(mockedSend).not.toHaveBeenCalled();
    expect(enrollmentOf('lead-1')).toMatchObject({ currentSequenceStep: 1, claimToken: 'worker' });
  });
});

describe('a send ACS accepted is recorded, never failed or sent again (H4, H5)', () => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  // Prisma's pool timeout names a "connection limit", which reads as a quota error.
  const poolTimeout = () => new Error('Timed out fetching a new connection from the connection pool. (Current connection pool timeout: 10, connection limit: 5)');

  it('stores the ACS operation id on the Sending dispatch before the send and sends under that id', async () => {
    const atSend: Array<{ operationId: unknown; dispatch: DispatchRow }> = [];
    mockedSend.mockImplementation(async (input) => {
      atSend.push({ operationId: input.operationId, dispatch: { ...dispatches[0] } });
      return { providerMessageId: 'provider-msg-1' };
    });

    await processDueEmails();

    expect(atSend).toHaveLength(1);
    const { operationId, dispatch } = atSend[0];
    expect(operationId).toMatch(UUID);
    expect(dispatch).toMatchObject({ status: 'Sending', operationId });
    expect(dispatches[0]).toMatchObject({ status: 'Sent', operationId, messageId: 'provider-msg-1' });
  });

  it('retries the bookkeeping after a database error instead of classifying it: no pause, no Failed dispatch, no resend', async () => {
    fake.$transaction.mockRejectedValueOnce(poolTimeout());

    await withFakeTimers(() => processDueEmails());

    expect(mockedSend).toHaveBeenCalledTimes(1);
    expect(fake.$transaction).toHaveBeenCalledTimes(2);
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]).toMatchObject({ status: 'Sent', messageId: 'provider-msg-1' });
    expect(campaign.status).toBe('Active');
    expect(enrollmentOf('lead-1')).toMatchObject({ currentSequenceStep: 2, retryCount: 0, lastError: null, claimToken: null });

    await processDueEmails();
    expect(mockedSend).toHaveBeenCalledTimes(1);
  });

  it('leaves the dispatch Sending with its operation id when every attempt fails, and never sends that step again', async () => {
    fake.$transaction.mockRejectedValue(new Error('Server has closed the connection.'));

    await withFakeTimers(() => processDueEmails());

    expect(mockedSend).toHaveBeenCalledTimes(1);
    expect(fake.$transaction).toHaveBeenCalledTimes(BOOKKEEPING_RETRIES + 1);
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]).toMatchObject({ status: 'Sending', operationId: expect.stringMatching(UUID) });
    expect(fake.emailDispatch.update).not.toHaveBeenCalled();
    expect(campaign.status).toBe('Active');
    expect(enrollmentOf('lead-1')).toMatchObject({ currentSequenceStep: 1, retryCount: 0, lastError: null, nextActionDate: PAST });
    expect(vi.mocked(console.error).mock.calls.some(([message]) => String(message).includes('ACCEPTED SEND NOT RECORDED'))).toBe(true);

    // Once the claim expires, later passes find the step's dispatch in Sending and leave it alone.
    enrollmentOf('lead-1').claimedAt = new Date(Date.now() - SEND_CLAIM_TTL_MS - 1);
    await processDueEmails();
    await run();
    expect(mockedSend).toHaveBeenCalledTimes(1);
    expect(dispatches).toHaveLength(1);
  });

  it('counts a warmup send in the same transaction that records it', async () => {
    campaign.senderAccount = { ...SENDER, warmupEnabled: true, warmupStartedAt: new Date() };

    await processDueEmails();

    expect(txWrites).toEqual(['emailDispatch', 'campaignEnrollment', 'senderAccount']);
    expect(fake.senderAccount.updateMany).toHaveBeenCalledWith({ where: { id: 'mb-1' }, data: { warmupSent: { increment: 1 } } });
    expect(fake.senderAccount.update).not.toHaveBeenCalled();
  });

  it('does not classify a failure to record the dispatch before the send: nothing is sent and the lead is not penalised', async () => {
    fake.emailDispatch.create.mockRejectedValueOnce(poolTimeout());

    await processDueEmails();

    expect(mockedSend).not.toHaveBeenCalled();
    expect(campaign.status).toBe('Active');
    expect(enrollmentOf('lead-1')).toMatchObject({
      currentSequenceStep: 1, retryCount: 0, lastError: null, nextActionDate: PAST, claimToken: null, claimedAt: null,
    });
  });

  it('the manual run reports an accepted send as dispatched after a database error, and records it', async () => {
    fake.$transaction.mockRejectedValueOnce(poolTimeout());

    const res = await withFakeTimers(() => run());

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, dispatchedCount: 1, errors: [] });
    expect(mockedSend).toHaveBeenCalledTimes(1);
    expect(mockedSend.mock.calls[0][0].operationId).toBe(dispatches[0].operationId);
    expect(dispatches[0]).toMatchObject({ status: 'Sent', messageId: 'provider-msg-1' });
    expect(campaign.status).toBe('Active');
    expect(enrollmentOf('lead-1')).toMatchObject({ currentSequenceStep: 2, retryCount: 0, claimToken: null });
  });

  it('the manual run still classifies a send the provider refused', async () => {
    mockedSend.mockRejectedValue(new Error('Connection timed out'));

    const res = await run();

    expect(await res.json()).toMatchObject({ success: false, dispatchedCount: 0, errors: [{ email: 'lead-1@prospect.test' }] });
    expect(dispatches[0].status).toBe('Failed');
    expect(enrollmentOf('lead-1')).toMatchObject({ currentSequenceStep: 1, retryCount: 1, claimToken: null });
  });
});
