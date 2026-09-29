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
  campaignEnrollment: { findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  emailDispatch: {
    create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), count: vi.fn(),
  },
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
  getAzureSendStatus: vi.fn(),
}));

import { getSession } from '../../lib/session';
import { getGlobalSettings } from '../../lib/settings';
import { checkGlobalRateLimits } from '../../lib/rateLimits';
import { sendMessage, getAzureSendStatus } from '../../lib/emailProvider';
import { processDueEmails, BOOKKEEPING_RETRIES } from '../../lib/sendEngine';
import { SEND_CLAIM_TTL_MS, claimEnrollmentForSend, releaseEnrollmentClaim } from '../../lib/sendEligibility';
import { reconcileStaleSendingDispatches, STALE_SENDING_MS, NOT_FOUND_RETRY_MAX_AGE_MS, RECONCILE_BATCH } from '../../lib/sendReconciler';
import { POST as postRun } from '../../app/api/campaigns/[id]/run/route';

const mockedSend = vi.mocked(sendMessage);
const mockedStatus = vi.mocked(getAzureSendStatus);

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
    messageId: `msg-${nextDispatchId}`, stepOrder: 1, sentAt: new Date(), operationId: null, ...row,
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
  if ('some' in cond && Object.keys(cond.some).length === 0) return value.length > 0;
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

function makeRunReq(query = ''): NextRequest {
  return new NextRequest(`http://localhost/api/campaigns/cmp-1/run${query}`, { method: 'POST' });
}
const run = (query?: string) => postRun(makeRunReq(query), { params: Promise.resolve({ id: 'cmp-1' }) });

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
  // The reconciler's stale-dispatch query, with the relations it selects.
  fake.emailDispatch.findMany.mockImplementation(async ({ where, take }: any) =>
    dispatches
      .filter((d) => matchesFields(d, where))
      .sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime())
      .slice(0, take)
      .map((d) => ({
        ...structuredClone(d),
        lead: { id: d.leadId, email: leads.get(d.leadId)?.email },
        senderAccount: d.senderAccountId === campaign.senderAccount.id
          ? { id: campaign.senderAccount.id, warmupEnabled: campaign.senderAccount.warmupEnabled }
          : null,
        campaign: d.campaignId === campaign.id
          ? { id: campaign.id, name: campaign.name, steps: campaign.steps.map(({ stepOrder, waitDays }: any) => ({ stepOrder, waitDays })) }
          : null,
      })),
  );
  fake.emailDispatch.deleteMany.mockImplementation(async ({ where }: any) => {
    const before = dispatches.length;
    dispatches = dispatches.filter((d) => !matchesFields(d, where));
    return { count: before - dispatches.length };
  });
  fake.campaignEnrollment.findFirst.mockImplementation(async ({ where }: any) => {
    const row = enrollments.find((e) => matchesEnrollment(e, where));
    return row ? structuredClone(row) : null;
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

describe('POST /api/campaigns/[id]/run only queues leads for the worker (H3, M66)', () => {
  const FUTURE = () => new Date(Date.now() + 3 * 86400000);

  /** Moves a lead's enrollment to `step`, waiting until `nextActionDate`. */
  function waitAt(leadId: string, step: number, nextActionDate: Date | null = FUTURE(), retryCount = 0) {
    Object.assign(enrollmentOf(leadId), { currentSequenceStep: step, nextActionDate, retryCount });
  }

  it('marks every sendable lead due at its current step, sends nothing itself, and the worker sends them', async () => {
    addLead('lead-2');
    addLead('lead-3');
    waitAt('lead-1', 1);
    waitAt('lead-2', 2);
    waitAt('lead-3', 3); // past the last step: nothing left to send

    const before = Date.now();
    const res = await run();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ queued: 2 });
    expect(mockedSend).not.toHaveBeenCalled();
    expect(dispatches).toHaveLength(0);
    for (const leadId of ['lead-1', 'lead-2']) {
      expect(enrollmentOf(leadId).nextActionDate!.getTime()).toBeGreaterThanOrEqual(before);
      expect(enrollmentOf(leadId).nextActionDate!.getTime()).toBeLessThanOrEqual(Date.now());
    }
    expect(enrollmentOf('lead-3').nextActionDate!.getTime()).toBeGreaterThan(Date.now());

    await processDueEmails();

    expect(mockedSend).toHaveBeenCalledTimes(2);
    expect(dispatches.map((d) => [d.leadId, d.stepOrder, d.status])).toEqual([
      ['lead-1', 1, 'Sent'],
      ['lead-2', 2, 'Sent'],
    ]);
  });

  it('Send Step queues only the leads at the requested step', async () => {
    addLead('lead-2');
    waitAt('lead-1', 1);
    waitAt('lead-2', 2);

    const res = await run('?stepOrder=2');

    expect(await res.json()).toEqual({ queued: 1 });
    expect(enrollmentOf('lead-1').nextActionDate!.getTime()).toBeGreaterThan(Date.now());
    expect(enrollmentOf('lead-2').nextActionDate!.getTime()).toBeLessThanOrEqual(Date.now());
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it('leaves a lead in soft-failure backoff at its retry time', async () => {
    addLead('lead-2');
    const retryAt = new Date(Date.now() + 3600000);
    waitAt('lead-1', 1, retryAt, 1);
    waitAt('lead-2', 1, PAST, 1); // its retry is already due

    const res = await run();

    expect(await res.json()).toEqual({ queued: 1 });
    expect(enrollmentOf('lead-1').nextActionDate).toEqual(retryAt);
    expect(enrollmentOf('lead-2').nextActionDate!.getTime()).toBeGreaterThan(PAST.getTime());
  });

  it.each<[string, () => void]>([
    ['the lead unsubscribed', () => { leads.get('lead-1')!.status = 'Unsubscribed'; }],
    ['the lead bounced', () => { leads.get('lead-1')!.status = 'Bounced'; }],
    ['the lead was marked Invalid', () => { leads.get('lead-1')!.validationStatus = 'Invalid'; }],
    ['the lead was archived', () => { leads.get('lead-1')!.isArchived = true; }],
    ['a reply paused the enrollment', () => { enrollmentOf('lead-1').status = 'Paused'; }],
    ['the enrollment Failed', () => { enrollmentOf('lead-1').status = 'Failed'; }],
  ])('does not queue a lead when %s', async (_label, change) => {
    const waitingUntil = FUTURE();
    waitAt('lead-1', 1, waitingUntil);
    change();

    const res = await run();

    expect(await res.json()).toEqual({ queued: 0 });
    expect(enrollmentOf('lead-1').nextActionDate).toEqual(waitingUntil);
  });

  it.each(['Paused', 'Draft'])('returns 409 for a %s campaign and queues nothing', async (status) => {
    campaign.status = status;
    waitAt('lead-1', 1);

    const res = await run();

    expect(res.status).toBe(409);
    expect((await res.json()).success).toBe(false);
    expect(fake.campaignEnrollment.updateMany).not.toHaveBeenCalled();
  });

  it.each(['?stepOrder=7', '?stepOrder=abc'])('returns 400 for a step the campaign does not have (%s)', async (query) => {
    const res = await run(query);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ success: false, error: 'This campaign has no such step.' });
    expect(fake.campaignEnrollment.updateMany).not.toHaveBeenCalled();
  });

  it('leaves the send to the worker, which holds a queued lead until the sending window opens', async () => {
    const today = new Date().toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short' });
    campaign.sendSchedule = {
      days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].filter((d) => d !== today),
      window: { start: '00:00', end: '23:59' },
    };
    waitAt('lead-1', 1);

    expect(await (await run()).json()).toEqual({ queued: 1 });
    await processDueEmails();

    expect(mockedSend).not.toHaveBeenCalled();
    expect(enrollmentOf('lead-1')).toMatchObject({ currentSequenceStep: 1, claimToken: null });
  });

  it('leaves the claim of an enrollment the background worker is sending', async () => {
    Object.assign(enrollmentOf('lead-1'), { claimToken: 'worker', claimedAt: new Date() });
    addDispatch({ status: 'Sending', stepOrder: 1 });

    const res = await run();

    expect(res.status).toBe(200);
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
    await run();
    await processDueEmails();
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

});

describe('sends interrupted by a crash are reconciled with ACS (H6)', () => {
  const OP = '5b0e7a52-3c1d-4d8e-9f10-2a3b4c5d6e7f';
  const staleAt = (extraMs = 60_000) => new Date(Date.now() - STALE_SENDING_MS - extraMs);

  /** A send the process died in the middle of: dispatch left Sending, enrollment claim abandoned. */
  function interruptedSend(row: Partial<DispatchRow> = {}) {
    const sentAt = row.sentAt ?? staleAt();
    Object.assign(enrollmentOf('lead-1'), { claimToken: 'crashed', claimedAt: sentAt });
    return addDispatch({ status: 'Sending', operationId: OP, ...row, sentAt });
  }

  it.each(['Succeeded', 'Running', 'NotStarted'] as const)(
    'records a send ACS reports %s as Sent and advances the enrollment as a normal send does',
    async (status) => {
      campaign.senderAccount = { ...SENDER, warmupEnabled: true, warmupStartedAt: new Date() };
      const dispatch = interruptedSend();
      mockedStatus.mockResolvedValue({ status });

      await reconcileStaleSendingDispatches();

      expect(mockedStatus).toHaveBeenCalledWith(OP, expect.objectContaining({ activeProvider: 'AZURE' }));
      expect(dispatches).toHaveLength(1);
      expect(dispatches[0]).toMatchObject({ status: 'Sent', messageId: OP });
      const nextActionDate = new Date(dispatch.sentAt);
      nextActionDate.setDate(nextActionDate.getDate() + 3);
      expect(enrollmentOf('lead-1')).toMatchObject({ currentSequenceStep: 2, nextActionDate, claimToken: null, claimedAt: null });
      expect(txWrites).toEqual(['emailDispatch', 'campaignEnrollment', 'senderAccount']);

      await processDueEmails();
      await reconcileStaleSendingDispatches();
      expect(mockedSend).not.toHaveBeenCalled();
      expect(mockedStatus).toHaveBeenCalledTimes(1);
    },
  );

  it('completes the enrollment when the interrupted send was its last step', async () => {
    enrollmentOf('lead-1').currentSequenceStep = 2;
    interruptedSend({ stepOrder: 2 });
    mockedStatus.mockResolvedValue({ status: 'Succeeded' });

    await reconcileStaleSendingDispatches();

    expect(dispatches[0].status).toBe('Sent');
    expect(enrollmentOf('lead-1')).toMatchObject({ status: 'Completed', nextActionDate: null, claimToken: null });
  });

  it('records a send ACS accepted whose bookkeeping never landed, without sending it again', async () => {
    for (let i = 0; i <= BOOKKEEPING_RETRIES; i++) {
      fake.$transaction.mockRejectedValueOnce(new Error('Server has closed the connection.'));
    }
    await withFakeTimers(() => processDueEmails());
    expect(dispatches[0].status).toBe('Sending');
    const { operationId } = dispatches[0];
    dispatches[0].sentAt = staleAt();
    mockedStatus.mockResolvedValue({ status: 'Succeeded' });

    await reconcileStaleSendingDispatches();

    expect(mockedStatus).toHaveBeenCalledWith(operationId, expect.anything());
    expect(dispatches[0]).toMatchObject({ status: 'Sent', messageId: operationId });
    expect(enrollmentOf('lead-1')).toMatchObject({ currentSequenceStep: 2, retryCount: 0, claimToken: null });
    expect(mockedSend).toHaveBeenCalledTimes(1);
  });

  it('records the send but leaves an enrollment no longer Active on that step to the send guard', async () => {
    interruptedSend();
    enrollmentOf('lead-1').status = 'Paused';
    mockedStatus.mockResolvedValue({ status: 'Succeeded' });

    await reconcileStaleSendingDispatches();

    expect(dispatches[0].status).toBe('Sent');
    expect(enrollmentOf('lead-1')).toMatchObject({ status: 'Paused', currentSequenceStep: 1 });

    enrollmentOf('lead-1').status = 'Active';
    await processDueEmails();
    expect(mockedSend).not.toHaveBeenCalled();
    expect(enrollmentOf('lead-1').currentSequenceStep).toBe(2);
  });

  it.each<[string, 'Failed' | 'Canceled', { code?: string; message?: string } | undefined]>([
    ['Failed with a transient error', 'Failed', { code: 'ServiceError', message: 'Temporary failure, try again later.' }],
    ['Canceled', 'Canceled', undefined],
  ])('handles a send ACS reports %s as a soft failure: dispatch Failed, step retried after backoff', async (_label, status, error) => {
    interruptedSend();
    mockedStatus.mockResolvedValue({ status, error });

    await reconcileStaleSendingDispatches();

    expect(dispatches[0].status).toBe('Failed');
    expect(enrollmentOf('lead-1')).toMatchObject({ currentSequenceStep: 1, retryCount: 1, lastBounceType: 'soft', claimToken: null });
    expect(enrollmentOf('lead-1').nextActionDate!.getTime()).toBeGreaterThan(Date.now());
    expect(fake.lead.update).not.toHaveBeenCalled();
    expect(campaign.status).toBe('Active');

    enrollmentOf('lead-1').nextActionDate = PAST;
    await processDueEmails();
    expect(mockedSend).toHaveBeenCalledTimes(1);
    expect(dispatches.map((d) => d.status)).toEqual(['Failed', 'Sent']);
  });

  it('handles a send ACS reports Failed for a bad address as a hard bounce', async () => {
    interruptedSend();
    mockedStatus.mockResolvedValue({ status: 'Failed', error: { code: 'InvalidRecipient', message: 'Recipient address rejected.' } });

    await reconcileStaleSendingDispatches();

    expect(dispatches[0].status).toBe('Failed');
    expect(enrollmentOf('lead-1')).toMatchObject({ status: 'Failed', lastBounceType: 'hard', lastError: 'Recipient address rejected.' });
    expect(fake.lead.update).toHaveBeenCalledWith({ where: { id: 'lead-1' }, data: { status: 'Bounced', validationStatus: 'Invalid' } });
    expect(fake.emailEvent.create).toHaveBeenCalledWith({ data: { messageId: dispatches[0].messageId, eventType: 'bounce' } });
  });

  it('deletes a dispatch ACS never received and clears the abandoned claim, so the next cycle sends the step', async () => {
    interruptedSend();
    mockedStatus.mockResolvedValue({ status: 'NotFound' });

    await reconcileStaleSendingDispatches();

    expect(dispatches).toHaveLength(0);
    expect(enrollmentOf('lead-1')).toMatchObject({ currentSequenceStep: 1, retryCount: 0, claimToken: null, claimedAt: null });

    await processDueEmails();
    expect(mockedSend).toHaveBeenCalledTimes(1);
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]).toMatchObject({ status: 'Sent', stepOrder: 1 });
  });

  it('does not clear a live claim when it deletes a dispatch ACS never received', async () => {
    interruptedSend();
    const claimedAt = new Date();
    Object.assign(enrollmentOf('lead-1'), { claimToken: 'manual-run', claimedAt });
    mockedStatus.mockResolvedValue({ status: 'NotFound' });

    await reconcileStaleSendingDispatches();

    expect(dispatches).toHaveLength(0);
    expect(enrollmentOf('lead-1')).toMatchObject({ claimToken: 'manual-run', claimedAt });
  });

  it('marks a dispatch over a day old that ACS no longer knows Unknown, and never sends that step again', async () => {
    interruptedSend({ sentAt: new Date(Date.now() - NOT_FOUND_RETRY_MAX_AGE_MS - 60_000) });
    mockedStatus.mockResolvedValue({ status: 'NotFound' });

    await reconcileStaleSendingDispatches();

    expect(dispatches).toHaveLength(1);
    expect(dispatches[0].status).toBe('Unknown');

    await processDueEmails();
    expect(mockedSend).not.toHaveBeenCalled();
    expect(enrollmentOf('lead-1')).toMatchObject({ currentSequenceStep: 2, claimToken: null });
  });

  it('marks interrupted dispatches with no operation id Unknown without asking ACS, logs the count, and never sends that step again', async () => {
    interruptedSend({ operationId: null });

    await reconcileStaleSendingDispatches();

    expect(mockedStatus).not.toHaveBeenCalled();
    expect(dispatches[0].status).toBe('Unknown');
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Marked 1 interrupted dispatch(es)'));

    await processDueEmails();
    expect(mockedSend).not.toHaveBeenCalled();
    expect(enrollmentOf('lead-1')).toMatchObject({ currentSequenceStep: 2, claimToken: null });
  });

  it('counts Unknown dispatches toward the mailbox daily cap', async () => {
    campaign.senderAccount = { ...SENDER, dailyLimit: 1 };
    addDispatch({ status: 'Unknown', leadId: 'lead-other', stepOrder: 1 });

    await processDueEmails();

    expect(mockedSend).not.toHaveBeenCalled();
    expect(enrollmentOf('lead-1').nextActionDate!.getTime()).toBeGreaterThan(Date.now());
  });

  it('leaves Sending dispatches younger than the stale threshold alone', async () => {
    addDispatch({ status: 'Sending', operationId: OP, sentAt: new Date(Date.now() - STALE_SENDING_MS + 60_000) });
    addDispatch({ status: 'Sending', operationId: null, sentAt: new Date() });

    await reconcileStaleSendingDispatches();

    expect(mockedStatus).not.toHaveBeenCalled();
    expect(dispatches.map((d) => d.status)).toEqual(['Sending', 'Sending']);
  });

  it('leaves dispatches Sending and stops the pass when ACS gives no answer, then settles them on a later pass', async () => {
    addLead('lead-2');
    interruptedSend();
    addDispatch({ status: 'Sending', operationId: 'op-2', leadId: 'lead-2', sentAt: staleAt(30_000) });
    mockedStatus.mockRejectedValue(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));

    await reconcileStaleSendingDispatches();

    expect(mockedStatus).toHaveBeenCalledTimes(1);
    expect(dispatches.map((d) => d.status)).toEqual(['Sending', 'Sending']);
    expect(enrollmentOf('lead-1')).toMatchObject({ currentSequenceStep: 1, retryCount: 0 });
    expect(campaign.status).toBe('Active');

    mockedStatus.mockResolvedValue({ status: 'Succeeded' });
    await reconcileStaleSendingDispatches();

    expect(dispatches.map((d) => d.status)).toEqual(['Sent', 'Sent']);
    expect(enrollmentOf('lead-1').currentSequenceStep).toBe(2);
    expect(enrollmentOf('lead-2').currentSequenceStep).toBe(2);
  });

  it('checks at most one batch of stale dispatches per pass', async () => {
    for (let i = 0; i <= RECONCILE_BATCH; i++) {
      addDispatch({ status: 'Sending', operationId: `op-${i}`, sentAt: staleAt(60_000 + i) });
    }
    mockedStatus.mockResolvedValue({ status: 'Running' });

    await reconcileStaleSendingDispatches();

    expect(mockedStatus).toHaveBeenCalledTimes(RECONCILE_BATCH);
    expect(dispatches.filter((d) => d.status === 'Sending')).toHaveLength(1);
  });

  it('asks ACS nothing while sending is disabled', async () => {
    vi.mocked(getGlobalSettings).mockResolvedValue({ id: 'global', activeProvider: 'DISABLED' } as any);
    interruptedSend();

    await reconcileStaleSendingDispatches();

    expect(mockedStatus).not.toHaveBeenCalled();
    expect(dispatches[0].status).toBe('Sending');
  });
});

describe('processDueEmails moves enrollments outside the sending window to its next opening (H10)', () => {
  const OFFICE_HOURS = { days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], window: { start: '09:00', end: '17:00' } };
  const SATURDAY_EVENING = new Date('2026-06-13T18:00:00Z');
  const MONDAY_OPENING = new Date('2026-06-15T09:00:00Z');

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(SATURDAY_EVENING);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits until the window opens instead of coming back every cycle, then sends', async () => {
    campaign.sendSchedule = OFFICE_HOURS;

    await processDueEmails();

    expect(mockedSend).not.toHaveBeenCalled();
    expect(enrollmentOf('lead-1')).toMatchObject({ currentSequenceStep: 1, nextActionDate: MONDAY_OPENING, claimToken: null });

    // No longer due, so later cycles before the opening leave it alone.
    await processDueEmails();
    expect(fake.campaignEnrollment.updateMany).toHaveBeenCalledTimes(1);
    expect(fake.campaign.findMany).toHaveBeenCalledTimes(1);

    vi.setSystemTime(MONDAY_OPENING);
    await processDueEmails();

    expect(mockedSend).toHaveBeenCalledTimes(1);
    expect(dispatches.map((d) => [d.stepOrder, d.status])).toEqual([[1, 'Sent']]);
    expect(enrollmentOf('lead-1').currentSequenceStep).toBe(2);
  });

  it.each<[string, () => void]>([
    ['no sending days', () => { campaign.sendSchedule = { days: [], window: { start: '09:00', end: '17:00' } }; }],
    ['an unknown timezone', () => { campaign.sendSchedule = OFFICE_HOURS; campaign.timezone = 'America/NewYork'; }],
  ])('checks again in a day and warns when the window never opens (%s)', async (_label, setup) => {
    setup();

    await processDueEmails();

    expect(mockedSend).not.toHaveBeenCalled();
    expect(enrollmentOf('lead-1').nextActionDate).toEqual(new Date('2026-06-14T18:00:00Z'));
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('sending window that never opens'));
  });

  it.each<[string, number]>([
    ['the enrollment moved on to the next step', 2],
    ['a retry was scheduled for the same step', 1],
  ])('keeps the date set after the batch was loaded when %s', async (_label, step) => {
    campaign.sendSchedule = OFFICE_HOURS;
    const setLater = new Date('2026-06-20T12:00:00Z');
    const loadBatch = fake.campaignEnrollment.findMany.getMockImplementation()!;
    fake.campaignEnrollment.findMany.mockImplementationOnce(async (args: any) => {
      const batch = await loadBatch(args);
      Object.assign(enrollmentOf('lead-1'), { currentSequenceStep: step, nextActionDate: setLater });
      return batch;
    });

    await processDueEmails();

    expect(mockedSend).not.toHaveBeenCalled();
    expect(enrollmentOf('lead-1')).toMatchObject({ currentSequenceStep: step, nextActionDate: setLater });
  });

  it('loads nothing from an Active campaign with no steps', async () => {
    campaign.steps = [];

    await processDueEmails();

    expect(fake.campaign.findMany).not.toHaveBeenCalled();
    expect(fake.campaignEnrollment.updateMany).not.toHaveBeenCalled();
    expect(enrollmentOf('lead-1').nextActionDate).toEqual(PAST);
  });
});
