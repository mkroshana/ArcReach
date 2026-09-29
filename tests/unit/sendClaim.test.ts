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
import { processDueEmails, BOOKKEEPING_RETRIES, MAX_SEND_ATTEMPTS, SENDER_CAP_WINDOW_MS } from '../../lib/sendEngine';
import { SEND_CLAIM_TTL_MS, claimEnrollmentForSend, releaseEnrollmentClaim, sendableEnrollmentWhere } from '../../lib/sendEligibility';
import { reconcileStaleSendingDispatches, STALE_SENDING_MS, NOT_FOUND_RETRY_MAX_AGE_MS, RECONCILE_BATCH } from '../../lib/sendReconciler';
import { POST as postRun } from '../../app/api/campaigns/[id]/run/route';
import { queuedLeadsMessage } from '../../lib/campaignSteps';

const mockedSend = vi.mocked(sendMessage);
const mockedStatus = vi.mocked(getAzureSendStatus);

type LeadRow = { id: string; email: string; name: string; status: string; validationStatus: string; isArchived: boolean };
type EnrollmentRow = {
  id: string; leadId: string; campaignId: string; status: string; currentSequenceStep: number;
  nextActionDate: Date | null; retryCount: number; quotaFailures: number; lastError: string | null; lastBounceType: string | null;
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
    nextActionDate: PAST, retryCount: 0, quotaFailures: 0, lastError: null, lastBounceType: null, claimToken: null, claimedAt: null,
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
  if ('gt' in cond) return value !== null && value > cond.gt;
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
    if (key === 'lead') return matchesLead(e.leadId, cond);
    return matchesValue((e as any)[key], cond);
  });
}

/** Evaluates a lead filter, including `dispatches: { none }` against the in-memory dispatches. */
function matchesLead(leadId: string, where: Record<string, any>): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key !== 'dispatches') return matchesValue((leads.get(leadId) as any)[key], cond);
    if (Object.keys(cond).join() !== 'none') throw new Error(`Unmodelled filter: ${JSON.stringify(cond)}`);
    return !dispatches.some((d) => d.leadId === leadId && matchesFields(d, cond.none));
  });
}

/** The field names a Prisma where filters on, through AND, OR and NOT. */
function whereFields(where: Record<string, any>): string[] {
  return Object.entries(where).flatMap(([key, cond]) =>
    ['AND', 'OR', 'NOT'].includes(key) ? [cond].flat().flatMap(whereFields) : [key],
  );
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
  // The step idempotency guard's lookup, and the sender-cap one ordered by sentAt.
  fake.emailDispatch.findFirst.mockImplementation(async ({ where, orderBy, skip = 0 }: any) => {
    const hits = dispatches.filter((d) => matchesFields(d, where));
    if (orderBy) {
      if (Object.keys(orderBy).join() !== 'sentAt') throw new Error(`Unmodelled orderBy: ${JSON.stringify(orderBy)}`);
      const direction = orderBy.sentAt === 'desc' ? -1 : 1;
      hits.sort((x, y) => direction * (x.sentAt.getTime() - y.sentAt.getTime()));
    }
    const row = hits[skip];
    return row ? { id: row.id, sentAt: row.sentAt } : null;
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

  it('claims with a write on the enrollment row\'s own columns only, then checks it is still sendable', async () => {
    const token = await claimEnrollmentForSend('enr-lead-1', 1, T0);

    expect(token).toEqual(expect.any(String));
    expect(fake.campaignEnrollment.updateMany).toHaveBeenCalledTimes(1);
    const [{ where, data }] = fake.campaignEnrollment.updateMany.mock.calls[0];
    // No campaign or lead relation filter, which Prisma would not evaluate on the locked row.
    expect(new Set(whereFields(where))).toEqual(new Set(['id', 'currentSequenceStep', 'status', 'claimedAt']));
    expect(where).toMatchObject({ id: 'enr-lead-1', currentSequenceStep: 1, status: 'Active' });
    expect(data).toEqual({ claimToken: token, claimedAt: T0 });
    expect(fake.campaignEnrollment.findFirst).toHaveBeenCalledWith({
      where: { ...sendableEnrollmentWhere(), id: 'enr-lead-1', claimToken: token },
      select: { id: true },
    });
  });

  it.each<[string, () => void]>([
    ['the campaign was paused', () => { campaign.status = 'Paused'; }],
    ['the lead unsubscribed', () => { leads.get('lead-1')!.status = 'Unsubscribed'; }],
    ['the lead was archived', () => { leads.get('lead-1')!.isArchived = true; }],
  ])('releases the claim it took when %s', async (_label, change) => {
    change();

    expect(await claimEnrollmentForSend('enr-lead-1', 1, T0)).toBeNull();

    const writes = fake.campaignEnrollment.updateMany.mock.calls.map(([args]: any[]) => args);
    expect(writes).toHaveLength(2);
    expect(writes[0].data).toEqual({ claimToken: expect.any(String), claimedAt: T0 });
    expect(writes[1]).toEqual({
      where: { id: 'enr-lead-1', claimToken: writes[0].data.claimToken },
      data: { claimToken: null, claimedAt: null },
    });
    expect(enrollmentOf('lead-1')).toMatchObject({ claimToken: null, claimedAt: null });
    // Released, it can be claimed again once it is sendable.
    campaign.status = 'Active';
    Object.assign(leads.get('lead-1')!, { status: 'Neutral', isArchived: false });
    expect(await claimEnrollmentForSend('enr-lead-1', 1, T0)).toEqual(expect.any(String));
  });

  it('leaves another send\'s claim in place when the enrollment is no longer sendable', async () => {
    Object.assign(enrollmentOf('lead-1'), { claimToken: 'other-send', claimedAt: T0 });
    campaign.status = 'Paused';

    expect(await claimEnrollmentForSend('enr-lead-1', 1, at(60_000))).toBeNull();

    expect(fake.campaignEnrollment.updateMany).toHaveBeenCalledTimes(1);
    expect(fake.campaignEnrollment.findFirst).not.toHaveBeenCalled();
    expect(enrollmentOf('lead-1')).toMatchObject({ claimToken: 'other-send', claimedAt: T0 });
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

  it('queues due leads and leads not emailed yet, sends nothing itself, and the worker sends them', async () => {
    addLead('lead-2');
    addLead('lead-3');
    addLead('lead-4');
    waitAt('lead-1', 1); // its first email was held back (sending window, sender cap)
    addDispatch({ status: 'Sent', leadId: 'lead-2', stepOrder: 1 });
    waitAt('lead-2', 2, PAST); // its follow-up is due
    addDispatch({ status: 'Sent', leadId: 'lead-3', stepOrder: 1 });
    waitAt('lead-3', 2, null);
    waitAt('lead-4', 3); // past the last step: nothing left to send

    const before = Date.now();
    const res = await run();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ queued: 3 });
    expect(mockedSend).not.toHaveBeenCalled();
    expect(dispatches).toHaveLength(2);
    for (const leadId of ['lead-1', 'lead-2', 'lead-3']) {
      expect(enrollmentOf(leadId).nextActionDate!.getTime()).toBeGreaterThanOrEqual(before);
      expect(enrollmentOf(leadId).nextActionDate!.getTime()).toBeLessThanOrEqual(Date.now());
    }
    expect(enrollmentOf('lead-4').nextActionDate!.getTime()).toBeGreaterThan(Date.now());

    await processDueEmails();

    expect(mockedSend).toHaveBeenCalledTimes(3);
    expect(dispatches.slice(2).map((d) => [d.leadId, d.stepOrder, d.status])).toEqual([
      ['lead-1', 1, 'Sent'],
      ['lead-2', 2, 'Sent'],
      ['lead-3', 2, 'Sent'],
    ]);
  });

  it('never pulls a follow-up forward: Run Now again after step 1 went out queues nothing until its wait days pass', async () => {
    expect(await (await run()).json()).toEqual({ queued: 1 });
    await processDueEmails();
    expect(dispatches.map((d) => [d.stepOrder, d.status])).toEqual([[1, 'Sent']]);
    const followUpAt = enrollmentOf('lead-1').nextActionDate!;
    expect(enrollmentOf('lead-1').currentSequenceStep).toBe(2);
    expect(followUpAt.getTime()).toBeGreaterThan(Date.now());

    const res = await run();

    expect(await res.json()).toEqual({ queued: 0 });
    expect(enrollmentOf('lead-1').nextActionDate).toEqual(followUpAt);

    await processDueEmails();

    expect(mockedSend).toHaveBeenCalledTimes(1);
  });

  it.each(['Sent', 'Sending', 'Unknown'])('does not pull a follow-up forward when step 1 is %s', async (status) => {
    addDispatch({ status, stepOrder: 1 });
    const followUpAt = FUTURE();
    waitAt('lead-1', 2, followUpAt);

    const res = await run();

    expect(await res.json()).toEqual({ queued: 0 });
    expect(enrollmentOf('lead-1').nextActionDate).toEqual(followUpAt);
  });

  it("counts a lead as not emailed yet when its only dispatches are another campaign's or Failed (a quota pause)", async () => {
    addDispatch({ status: 'Sent', campaignId: 'cmp-other', stepOrder: 1 });
    addDispatch({ status: 'Failed', stepOrder: 1 });
    waitAt('lead-1', 1);

    const res = await run();

    expect(await res.json()).toEqual({ queued: 1 });
    expect(enrollmentOf('lead-1').nextActionDate!.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('Send Step queues every lead at the requested step, skipping its wait days, and no other', async () => {
    addLead('lead-2');
    waitAt('lead-1', 1);
    addDispatch({ status: 'Sent', leadId: 'lead-2', stepOrder: 1 });
    waitAt('lead-2', 2);

    const res = await run('?stepOrder=2');

    expect(await res.json()).toEqual({ queued: 1 });
    expect(enrollmentOf('lead-1').nextActionDate!.getTime()).toBeGreaterThan(Date.now());
    expect(enrollmentOf('lead-2').nextActionDate!.getTime()).toBeLessThanOrEqual(Date.now());
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it.each(['', '?stepOrder=1'])('leaves a lead in soft-failure backoff at its retry time (%s)', async (query) => {
    addLead('lead-2');
    const retryAt = new Date(Date.now() + 3600000);
    waitAt('lead-1', 1, retryAt, 1);
    waitAt('lead-2', 1, PAST, 1); // its retry is already due

    const res = await run(query);

    expect(await res.json()).toEqual({ queued: 1 });
    expect(enrollmentOf('lead-1').nextActionDate).toEqual(retryAt);
    expect(enrollmentOf('lead-2').nextActionDate!.getTime()).toBeGreaterThan(PAST.getTime());
  });

  it.each<[string, string, Partial<EnrollmentRow>]>([
    ['the worker sends its step and schedules the next one (Run Now)', '', { currentSequenceStep: 2 }],
    ['the worker sends its step and schedules the next one (Send Step)', '?stepOrder=1', { currentSequenceStep: 2 }],
    ['a soft failure backs it off', '', { retryCount: 1 }],
  ])('does not queue a lead when %s between the read and the write', async (_label, query, change) => {
    addLead('lead-2');
    waitAt('lead-1', 1);
    waitAt('lead-2', 1);
    const later = FUTURE();
    const readSendable = fake.campaignEnrollment.findMany.getMockImplementation()!;
    fake.campaignEnrollment.findMany.mockImplementationOnce(async (args: any) => {
      const rows = await readSendable(args);
      Object.assign(enrollmentOf('lead-1'), { ...change, nextActionDate: later });
      return rows;
    });

    const res = await run(query);

    expect(await res.json()).toEqual({ queued: 1 });
    expect(enrollmentOf('lead-1').nextActionDate).toEqual(later);
    expect(enrollmentOf('lead-2').nextActionDate!.getTime()).toBeLessThanOrEqual(Date.now());
    // The write re-checks only the enrollment's own columns, which Postgres re-evaluates on the locked row.
    const [{ where }] = fake.campaignEnrollment.updateMany.mock.calls[0];
    expect(whereFields(where)).not.toContain('campaign');
    expect(whereFields(where)).not.toContain('lead');
  });

  it('queues a large campaign in writes of at most 1000 ids and counts them all', async () => {
    for (let n = 2; n <= 1001; n++) addLead(`lead-${n}`);
    for (const e of enrollments) e.nextActionDate = FUTURE();

    const res = await run();

    expect(await res.json()).toEqual({ queued: 1001 });
    const idCounts = fake.campaignEnrollment.updateMany.mock.calls.map(([{ where }]: any[]) => where.id.in.length);
    expect(idCounts).toEqual([1000, 1]);
    expect(enrollments.every((e) => e.nextActionDate!.getTime() <= Date.now())).toBe(true);
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

  it('reports Run Now as queuing due leads and Send Step by its step', () => {
    const sending = "Sending starts within 30 seconds, inside the campaign's sending window.";
    expect(queuedLeadsMessage(0)).toBe('No leads are due. Follow-ups are sent once their wait days pass.');
    expect(queuedLeadsMessage(1)).toBe(`Queued 1 due lead. ${sending}`);
    expect(queuedLeadsMessage(12)).toBe(`Queued 12 due leads. ${sending}`);
    expect(queuedLeadsMessage(0, 2)).toBe('No leads to queue at step 2.');
    expect(queuedLeadsMessage(3, 2)).toBe(`Queued 3 leads at step 2. ${sending}`);
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

describe('processDueEmails pauses the campaign on a systemic failure and never penalises the lead (H9, M2)', () => {
  const HOUR_MS = 60 * 60 * 1000;

  beforeEach(() => {
    // Pauses only the Active campaign it names, as the engine's conditional write does.
    fake.campaign.updateMany.mockImplementation(async ({ where, data }: any) => {
      const hit = where.id === campaign.id && where.status === campaign.status;
      if (hit) Object.assign(campaign, data);
      return { count: hit ? 1 : 0 };
    });
  });

  it('pauses on a connection string that cannot be decrypted, leaving the retries and the lead alone', async () => {
    // The real provider, under the saved settings' 'enc:v1:conn', which no SECRETS_KEY decrypts.
    const actual = await vi.importActual<typeof import('../../lib/emailProvider')>('../../lib/emailProvider');
    mockedSend.mockImplementation(actual.sendMessage);
    addLead('lead-2');
    enrollmentOf('lead-1').retryCount = MAX_SEND_ATTEMPTS - 1; // one more soft failure would fail the lead
    const before = Date.now();

    await processDueEmails();

    // The cycle stops at the first failure: every send would fail the same way.
    expect(mockedSend).toHaveBeenCalledTimes(1);
    expect(campaign).toMatchObject({ status: 'Paused', pauseReason: 'config' });
    expect(campaign.pausedUntil.getTime() - before).toBeGreaterThanOrEqual(HOUR_MS);
    expect(enrollmentOf('lead-1')).toMatchObject({
      status: 'Active', currentSequenceStep: 1, retryCount: MAX_SEND_ATTEMPTS - 1, quotaFailures: 0, lastError: null,
      nextActionDate: campaign.pausedUntil, claimToken: null, claimedAt: null,
    });
    expect(enrollmentOf('lead-2')).toMatchObject({ status: 'Active', retryCount: 0, nextActionDate: PAST });
    expect(dispatches.map((d) => d.status)).toEqual(['Failed']);
    expect(fake.lead.update).not.toHaveBeenCalled();
    expect(leads.get('lead-1')).toMatchObject({ status: 'Neutral', validationStatus: 'Valid' });
  });

  it('ends a quota streak when the step is sent', async () => {
    enrollmentOf('lead-1').quotaFailures = 3;

    await processDueEmails();

    expect(enrollmentOf('lead-1')).toMatchObject({ currentSequenceStep: 2, quotaFailures: 0 });
  });
});

describe('a sent step resets the retry budget, which is per step (M1)', () => {
  const timeout = () => new Error('Connection timed out');

  it('gives step 2 its full retry budget after step 1 needed every retry but the last', async () => {
    for (let attempt = 1; attempt < MAX_SEND_ATTEMPTS; attempt++) {
      mockedSend.mockRejectedValueOnce(timeout());
      await processDueEmails();
      enrollmentOf('lead-1').nextActionDate = PAST; // the backoff has passed
    }
    expect(enrollmentOf('lead-1')).toMatchObject({ currentSequenceStep: 1, retryCount: MAX_SEND_ATTEMPTS - 1, lastError: 'Connection timed out' });

    await processDueEmails();

    expect(enrollmentOf('lead-1')).toMatchObject({ currentSequenceStep: 2, retryCount: 0, lastError: null });

    // A transient failure on step 2 backs off instead of failing the lead.
    enrollmentOf('lead-1').nextActionDate = PAST;
    mockedSend.mockRejectedValueOnce(timeout());
    await processDueEmails();

    expect(enrollmentOf('lead-1')).toMatchObject({ status: 'Active', currentSequenceStep: 2, retryCount: 1 });
    expect(enrollmentOf('lead-1').nextActionDate!.getTime()).toBeGreaterThan(Date.now());
    expect(fake.lead.update).not.toHaveBeenCalled();
    expect(leads.get('lead-1')!.validationStatus).toBe('Valid');
  });

  it('does not treat a lead waiting out its wait days after a retried step as in backoff: Send Step queues it, Run Now does not', async () => {
    mockedSend.mockRejectedValueOnce(timeout());
    await processDueEmails();
    enrollmentOf('lead-1').nextActionDate = PAST;
    await processDueEmails();
    const followUpAt = enrollmentOf('lead-1').nextActionDate!;
    expect(enrollmentOf('lead-1')).toMatchObject({ currentSequenceStep: 2, retryCount: 0 });
    expect(followUpAt.getTime()).toBeGreaterThan(Date.now());

    expect(await (await run()).json()).toEqual({ queued: 0 });
    expect(enrollmentOf('lead-1').nextActionDate).toEqual(followUpAt);

    expect(await (await run('?stepOrder=2')).json()).toEqual({ queued: 1 });
    expect(enrollmentOf('lead-1').nextActionDate!.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('resets the retry budget when the reconciler records a retried send ACS accepted', async () => {
    const sentAt = new Date(Date.now() - STALE_SENDING_MS - 60_000);
    Object.assign(enrollmentOf('lead-1'), { retryCount: 2, lastError: 'Connection timed out', claimToken: 'crashed', claimedAt: sentAt });
    addDispatch({ status: 'Sending', operationId: 'op-1', sentAt });
    mockedStatus.mockResolvedValue({ status: 'Succeeded' });

    await reconcileStaleSendingDispatches();

    expect(dispatches[0].status).toBe('Sent');
    expect(enrollmentOf('lead-1')).toMatchObject({ currentSequenceStep: 2, retryCount: 0, lastError: null, claimToken: null });
  });
});

describe('the next step is dated from the send, even when the cycle crosses midnight at a month end (M3)', () => {
  // Local times: setDate counts local calendar days.
  const CYCLE_START = new Date(2027, 0, 31, 23, 59, 50);
  const SENT_AT = new Date(2027, 1, 1, 0, 0, 10);
  const WAIT_DAYS_LATER = new Date(2027, 1, 4, 0, 0, 10);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(CYCLE_START);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('schedules the follow-up its wait days after a send that went out after midnight', async () => {
    mockedSend.mockImplementation(async () => {
      vi.setSystemTime(SENT_AT);
      return { providerMessageId: 'provider-msg-1' };
    });

    await processDueEmails();

    expect(enrollmentOf('lead-1')).toMatchObject({ currentSequenceStep: 2, nextActionDate: WAIT_DAYS_LATER });
  });

  it('dates the follow-up the same way when a pass advances past a step already sent, resetting its retries', async () => {
    addDispatch({ status: 'Sent', stepOrder: 1, sentAt: CYCLE_START });
    enrollmentOf('lead-1').retryCount = 1;
    const findDispatch = fake.emailDispatch.findFirst.getMockImplementation()!;
    fake.emailDispatch.findFirst.mockImplementationOnce(async (args: any) => {
      vi.setSystemTime(SENT_AT);
      return findDispatch(args);
    });

    await processDueEmails();

    expect(mockedSend).not.toHaveBeenCalled();
    expect(enrollmentOf('lead-1')).toMatchObject({
      currentSequenceStep: 2, nextActionDate: WAIT_DAYS_LATER, retryCount: 0, lastError: null, claimToken: null,
    });
  });
});

describe('per-mailbox caps count real sends over a rolling 24 hours (M10, M11)', () => {
  const HOUR = 3600000;
  // A server clock half an hour past midnight UTC, which reset the old count.
  const NOW = new Date('2026-03-11T00:30:00Z');
  const ago = (ms: number) => new Date(NOW.getTime() - ms);
  const SECOND_SENDER = { ...SENDER, id: 'mb-2', emailAddress: 'two@acme.test', name: 'Two' };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not count Failed attempts toward the cap', async () => {
    campaign.senderAccount = { ...SENDER, dailyLimit: 2 };
    addDispatch({ status: 'Failed', leadId: 'lead-other', sentAt: ago(HOUR) });
    addDispatch({ status: 'Failed', leadId: 'lead-other', sentAt: ago(2 * HOUR) });

    await processDueEmails();

    expect(mockedSend).toHaveBeenCalledTimes(1);
    expect(enrollmentOf('lead-1').currentSequenceStep).toBe(2);
  });

  it('keeps counting sends made before midnight, and defers to when the oldest leaves the window, not to midnight', async () => {
    campaign.senderAccount = { ...SENDER, dailyLimit: 2 };
    addDispatch({ status: 'Sent', leadId: 'lead-other', sentAt: ago(7 * HOUR) });
    addDispatch({ status: 'Sent', leadId: 'lead-other', sentAt: ago(3 * HOUR) });
    addLead('lead-2');
    addLead('lead-3');

    await processDueEmails();

    expect(mockedSend).not.toHaveBeenCalled();
    for (const leadId of ['lead-1', 'lead-2', 'lead-3']) {
      expect(enrollmentOf(leadId)).toMatchObject({ currentSequenceStep: 1, nextActionDate: new Date(ago(7 * HOUR).getTime() + SENDER_CAP_WINDOW_MS) });
    }
    // Looked up once for the mailbox, not once per deferred lead.
    expect(fake.emailDispatch.findFirst.mock.calls.filter(([args]: any) => args.orderBy)).toHaveLength(1);
  });

  it('stops counting a send exactly 24 hours after it was made', async () => {
    campaign.senderAccount = { ...SENDER, dailyLimit: 1 };
    addDispatch({ status: 'Sent', leadId: 'lead-other', sentAt: ago(SENDER_CAP_WINDOW_MS) });

    await processDueEmails();

    expect(mockedSend).toHaveBeenCalledTimes(1);
  });

  it('defers until enough sends leave the window to drop under a warmup cap already exceeded', async () => {
    campaign.senderAccount = { ...SENDER, warmupEnabled: true, warmupStartedAt: ago(HOUR), warmupLimit: 2, warmupRamp: 5 };
    addDispatch({ status: 'Sent', leadId: 'lead-other', sentAt: ago(20 * HOUR) });
    addDispatch({ status: 'Unknown', leadId: 'lead-other', sentAt: ago(10 * HOUR) });
    addDispatch({ status: 'Sending', leadId: 'lead-other', sentAt: ago(HOUR) });
    addDispatch({ status: 'Failed', leadId: 'lead-other', sentAt: ago(HOUR / 2) });

    await processDueEmails();

    // Three count against a cap of 2: under it once the 10-hour-old send leaves too.
    expect(mockedSend).not.toHaveBeenCalled();
    expect(enrollmentOf('lead-1').nextActionDate).toEqual(new Date(ago(10 * HOUR).getTime() + SENDER_CAP_WINDOW_MS));
  });

  it('defers a pool to the first mailbox that frees up, then sends from it', async () => {
    campaign.senderAccount = { ...SENDER, dailyLimit: 1 };
    campaign.senders = [
      { senderAccountId: 'mb-1', senderAccount: { ...SENDER, dailyLimit: 1 } },
      { senderAccountId: 'mb-2', senderAccount: { ...SECOND_SENDER, dailyLimit: 1 } },
    ];
    addDispatch({ status: 'Sent', leadId: 'lead-other', senderAccountId: 'mb-1', sentAt: ago(2 * HOUR) });
    addDispatch({ status: 'Sent', leadId: 'lead-other', senderAccountId: 'mb-2', sentAt: ago(20 * HOUR) });

    await processDueEmails();

    const freesAt = new Date(ago(20 * HOUR).getTime() + SENDER_CAP_WINDOW_MS);
    expect(mockedSend).not.toHaveBeenCalled();
    expect(enrollmentOf('lead-1').nextActionDate).toEqual(freesAt);

    vi.setSystemTime(freesAt);
    await processDueEmails();

    expect(mockedSend).toHaveBeenCalledTimes(1);
    expect(mockedSend).toHaveBeenCalledWith(expect.objectContaining({ sender: expect.objectContaining({ id: 'mb-2' }) }), expect.anything());
    expect(dispatches.at(-1)).toMatchObject({ leadId: 'lead-1', senderAccountId: 'mb-2', status: 'Sent' });
  });

  it('checks again in a day when every cap is 0', async () => {
    campaign.senderAccount = { ...SENDER, dailyLimit: 0 };

    await processDueEmails();

    expect(mockedSend).not.toHaveBeenCalled();
    expect(enrollmentOf('lead-1').nextActionDate).toEqual(new Date(NOW.getTime() + SENDER_CAP_WINDOW_MS));
  });
});

describe('processDueEmails personalises each step with the shared personalizeEmail (H22, L11)', () => {
  it('keeps the styling, the unsubscribe link and unknown fields, and never reads lead values as spintax or $-patterns', async () => {
    campaign.trackClicks = true;
    campaign.steps[0] = {
      stepOrder: 1, waitDays: 0, subject: 'Hello {{firstName}}',
      body: "<style>.btn{color:#fff}</style><p>Hi {{name}} of {{company}} in {{city}}</p><a href='{{unsubscribe_url}}'>Unsubscribe</a>",
    };
    Object.assign(leads.get('lead-1')!, { name: "Cash$'n'Carry Kid", company: '{Wayne|Stark} Industries' });

    await processDueEmails();

    expect(mockedSend).toHaveBeenCalledTimes(1);
    const sent = mockedSend.mock.calls[0][0];
    expect(sent.subject).toBe("Hello Cash$'n'Carry");
    expect(sent.body).toContain('<style>.btn{color:#fff}</style>');
    expect(sent.body).toContain('<p>Hi Cash$&#39;n&#39;Carry Kid of {Wayne|Stark} Industries in {{city}}</p>');
    expect(sent.body).toMatch(/<a href='[^']*\/api\/unsubscribe\?id=lead-1'>Unsubscribe<\/a>/);
    expect(sent.body).not.toContain('If you no longer wish to receive these emails');
  });
});

describe('processDueEmails decides HTML from the step template and escapes lead values (M5)', () => {
  it('sends a plain-text step as text, with angle brackets in the signature and the lead values kept as written', async () => {
    campaign.steps[0] = { stepOrder: 1, waitDays: 0, subject: 'Hi', body: 'Hi {{company}},\n\nThanks,\nJane <jane@acme.com>' };
    Object.assign(leads.get('lead-1')!, { company: 'Smith <Holdings>' });

    await processDueEmails();

    expect(mockedSend).toHaveBeenCalledTimes(1);
    expect(mockedSend.mock.calls[0][0]).toMatchObject({
      isHtml: false,
      body: 'Hi Smith <Holdings>,\n\nThanks,\nJane <jane@acme.com>',
    });
  });

  it('HTML-escapes lead values in an HTML step and URL-encodes them in a click-tracked link', async () => {
    campaign.trackClicks = true;
    campaign.steps[0] = {
      stepOrder: 1, waitDays: 0, subject: 'Hi {{company}}',
      body: '<p>Hi {{firstName}} of {{company}}</p><a href="https://acme.test/demo?who={{firstName}}&co={{company}}">Book</a>',
    };
    Object.assign(leads.get('lead-1')!, { name: "D'Arcy Stone", company: 'Smith <Holdings> & Co' });

    await processDueEmails();

    expect(mockedSend).toHaveBeenCalledTimes(1);
    const sent = mockedSend.mock.calls[0][0];
    expect(sent.isHtml).toBe(true);
    expect(sent.subject).toBe('Hi Smith <Holdings> & Co');
    expect(sent.body).toContain('<p>Hi D&#39;Arcy of Smith &lt;Holdings&gt; &amp; Co</p>');
    expect(sent.body).toContain(
      `/api/track/click/dispatch-1?url=${encodeURIComponent('https://acme.test/demo?who=D%27Arcy&co=Smith%20%3CHoldings%3E%20%26%20Co')}"`,
    );
  });
});
