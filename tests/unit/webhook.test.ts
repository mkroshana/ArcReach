import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * In-memory dispatches, leads, enrollments, events and suppression list. The
 * fake models evaluate the where clauses lib/deliveryReport builds, and
 * $transaction rolls every table back when its callback throws, so the tests
 * check the rows a delivery report really leaves behind.
 */
const fake = vi.hoisted(() => ({
  emailDispatch: { findUnique: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() },
  lead: { update: vi.fn() },
  campaignEnrollment: { updateMany: vi.fn() },
  emailEvent: { create: vi.fn() },
  suppressedEmail: { createMany: vi.fn() },
  $transaction: vi.fn(),
}));

vi.mock('../../lib/db', () => ({ prisma: fake }));

import { POST } from '../../app/api/webhook/route';
import { classifyDeliveryFailure, parseDeliveryStatus } from '../../lib/deliveryReport';

function makeReq(body: any, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost/api/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('webhook POST auth', () => {
  const ORIG_SECRET = process.env.WEBHOOK_SECRET;

  beforeEach(() => {
    process.env.WEBHOOK_SECRET = 'test-secret-value';
  });
  afterEach(() => {
    if (ORIG_SECRET === undefined) delete process.env.WEBHOOK_SECRET;
    else process.env.WEBHOOK_SECRET = ORIG_SECRET;
  });

  it('returns 500 when WEBHOOK_SECRET is not configured', async () => {
    delete process.env.WEBHOOK_SECRET;
    const res = await POST(makeReq([], { 'x-arcreach-webhook-secret': 'anything' }));
    expect(res.status).toBe(500);
  });

  it('returns 401 when the secret header is missing', async () => {
    const res = await POST(makeReq([]));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/header missing/i);
  });

  it('returns 401 when the secret header is wrong', async () => {
    const res = await POST(makeReq([], { 'x-arcreach-webhook-secret': 'wrong' }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/invalid/i);
  });

  it('returns 401 even when the wrong secret is the same length (timing-safe path)', async () => {
    const res = await POST(
      makeReq([], { 'x-arcreach-webhook-secret': 'test-secret-XXXXX' })
    );
    expect(res.status).toBe(401);
  });

  it('passes auth and echoes the EventGrid validation code on the handshake', async () => {
    const event = {
      eventType: 'Microsoft.EventGrid.SubscriptionValidationEvent',
      data: { validationCode: 'abc-123' },
    };
    const res = await POST(
      makeReq([event], { 'x-arcreach-webhook-secret': 'test-secret-value' })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.validationResponse).toBe('abc-123');
  });
});

type DispatchRow = {
  id: string; leadId: string | null; campaignId: string | null; messageId: string; operationId: string | null;
  deliveryStatus: string | null; deliveredAt: Date | null; bouncedAt: Date | null; bounceType: string | null;
};
type LeadRow = { id: string; email: string; status: string; validationStatus: string };
type EnrollmentRow = {
  id: string; leadId: string; campaignId: string; status: string; nextActionDate: Date | null;
  lastError: string | null; lastBounceType: string | null;
};

let dispatches: DispatchRow[];
let leads: LeadRow[];
let enrollments: EnrollmentRow[];
let events: { messageId: string; eventType: string }[];
let suppressed: { email: string; reason: string; source: string }[];

const DUE = new Date('2026-03-12T09:00:00Z');
/** When ACS attempted delivery, as its reports carry it (seven fractional digits). */
const ATTEMPTED_AT = '2026-03-11T10:15:30.1234567Z';

function addDispatch(row: Partial<DispatchRow> & { id: string }): DispatchRow {
  const dispatch: DispatchRow = {
    leadId: 'lead-1', campaignId: 'cmp-1', messageId: `op-${row.id}`, operationId: `op-${row.id}`,
    deliveryStatus: null, deliveredAt: null, bouncedAt: null, bounceType: null, ...row,
  };
  dispatches.push(dispatch);
  return dispatch;
}

const dispatch = (id: string) => dispatches.find((d) => d.id === id)!;
const lead = (id: string) => leads.find((l) => l.id === id)!;
const enrollment = (id: string) => enrollments.find((e) => e.id === id)!;

/** Evaluates a where clause over one row; throws on shapes it doesn't model so a changed query can't silently match. */
function matches(row: any, where: Record<string, any>): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return cond.some((w: any) => matches(row, w));
    if (cond === null || typeof cond !== 'object') return (row[key] ?? null) === cond;
    if (cond.mode === 'insensitive' && 'equals' in cond) {
      return typeof row[key] === 'string' && row[key].toLowerCase() === cond.equals.toLowerCase();
    }
    throw new Error(`Unmodelled filter: ${key} ${JSON.stringify(cond)}`);
  });
}

function pick(row: any, select?: Record<string, boolean>) {
  if (!row) return null;
  if (!select) return { ...row };
  return Object.fromEntries(Object.keys(select).map((key) => [key, row[key]]));
}

function snapshot() {
  return structuredClone({ dispatches, leads, enrollments, events, suppressed });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.WEBHOOK_SECRET = 'test-secret-value';
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});

  dispatches = [];
  leads = [
    { id: 'lead-1', email: 'jane@example.com', status: 'Neutral', validationStatus: 'Valid' },
    { id: 'lead-2', email: 'sam@example.com', status: 'Neutral', validationStatus: 'Valid' },
  ];
  enrollments = [
    { id: 'enr-1', leadId: 'lead-1', campaignId: 'cmp-1', status: 'Active', nextActionDate: DUE, lastError: null, lastBounceType: null },
    { id: 'enr-2', leadId: 'lead-1', campaignId: 'cmp-2', status: 'Active', nextActionDate: DUE, lastError: null, lastBounceType: null },
    { id: 'enr-3', leadId: 'lead-1', campaignId: 'cmp-3', status: 'Completed', nextActionDate: null, lastError: null, lastBounceType: null },
  ];
  events = [];
  suppressed = [];

  fake.emailDispatch.findUnique.mockImplementation(async ({ where, select }: any) =>
    pick(dispatches.find((d) => matches(d, where)), select));
  fake.emailDispatch.findFirst.mockImplementation(async ({ where, select }: any) =>
    pick(dispatches.find((d) => matches(d, where)), select));
  fake.emailDispatch.updateMany.mockImplementation(async ({ where, data }: any) => {
    const hit = dispatches.filter((d) => matches(d, where));
    for (const d of hit) Object.assign(d, data);
    return { count: hit.length };
  });
  fake.lead.update.mockImplementation(async ({ where, data }: any) => {
    const row = leads.find((l) => l.id === where.id);
    if (!row) throw new Error('Record to update not found.');
    Object.assign(row, data);
    return { ...row };
  });
  fake.campaignEnrollment.updateMany.mockImplementation(async ({ where, data }: any) => {
    const hit = enrollments.filter((e) => matches(e, where));
    for (const e of hit) Object.assign(e, data);
    return { count: hit.length };
  });
  fake.emailEvent.create.mockImplementation(async ({ data }: any) => {
    // EmailEvent.messageId is a foreign key to EmailDispatch.messageId.
    if (!dispatches.some((d) => d.messageId === data.messageId)) throw new Error('Foreign key constraint failed.');
    events.push(data);
    return data;
  });
  fake.suppressedEmail.createMany.mockImplementation(async ({ data, skipDuplicates }: any) => {
    expect(skipDuplicates).toBe(true);
    const fresh = data.filter((row: any) => !suppressed.some((s) => s.email === row.email));
    suppressed.push(...fresh);
    return { count: fresh.length };
  });
  fake.$transaction.mockImplementation(async (fn: (tx: typeof fake) => unknown) => {
    const before = snapshot();
    try {
      return await fn(fake);
    } catch (err) {
      ({ dispatches, leads, enrollments, events, suppressed } = before);
      throw err;
    }
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function report(messageId: string, status: unknown, statusMessage?: string) {
  return {
    eventType: 'Microsoft.Communication.EmailDeliveryReportReceived',
    eventTime: '2026-03-11T10:15:31Z',
    data: {
      messageId,
      status,
      deliveryAttemptTimeStamp: ATTEMPTED_AT,
      ...(statusMessage === undefined ? {} : { deliveryStatusDetails: { statusMessage } }),
    },
  };
}

const post = (batch: unknown[]) => POST(makeReq(batch, { 'x-arcreach-webhook-secret': 'test-secret-value' }));

/** The lead, its enrollments and the suppression list as no report has touched them. */
function expectLeadUntouched() {
  expect(lead('lead-1')).toMatchObject({ status: 'Neutral', validationStatus: 'Valid' });
  expect(enrollments.map((e) => e.status)).toEqual(['Active', 'Active', 'Completed']);
  expect(suppressed).toEqual([]);
}

function expectHardBounce(id: string, status: string) {
  expect(dispatch(id)).toMatchObject({ deliveryStatus: status, bounceType: 'hard', bouncedAt: new Date(ATTEMPTED_AT) });
  expect(lead('lead-1')).toMatchObject({ status: 'Bounced', validationStatus: 'Invalid' });
  expect(suppressed).toEqual([{ email: 'jane@example.com', reason: 'HardBounce', source: 'delivery-webhook' }]);
  // The lead's Active enrollments in every campaign stop; a finished one is left as it is.
  expect(enrollment('enr-1')).toMatchObject({ status: 'Bounced', nextActionDate: null, lastBounceType: 'hard' });
  expect(enrollment('enr-1').lastError).toContain(`Azure delivery report: ${status}`);
  expect(enrollment('enr-2')).toMatchObject({ status: 'Bounced', nextActionDate: null, lastBounceType: 'hard' });
  expect(enrollment('enr-3')).toMatchObject({ status: 'Completed' });
  expect(events).toEqual([{ messageId: dispatch(id).messageId, eventType: 'bounce' }]);
}

describe('webhook delivery reports map every ACS status (H20)', () => {
  it('Delivered records when it was delivered and touches no lead', async () => {
    addDispatch({ id: 'd-1' });

    const res = await post([report('op-d-1', 'Delivered')]);

    expect(res.status).toBe(200);
    expect(dispatch('d-1')).toMatchObject({
      deliveryStatus: 'Delivered', deliveredAt: new Date(ATTEMPTED_AT), bouncedAt: null, bounceType: null,
    });
    expectLeadUntouched();
    expect(events).toEqual([]);
  });

  it.each(['Bounced', 'Suppressed'])('%s is a hard bounce: the dispatch bounces, the lead is suppressed and its active enrollments stop', async (status) => {
    addDispatch({ id: 'd-1' });

    const res = await post([report('op-d-1', status)]);

    expect(res.status).toBe(200);
    expectHardBounce('d-1', status);
  });

  it.each(['Quarantined', 'FilteredSpam'])('%s is recorded on the dispatch without bouncing it or touching the lead', async (status) => {
    addDispatch({ id: 'd-1' });

    const res = await post([report('op-d-1', status, 'Message was identified as spam.')]);

    expect(res.status).toBe(200);
    expect(dispatch('d-1')).toMatchObject({ deliveryStatus: status, deliveredAt: null, bouncedAt: null, bounceType: null });
    expectLeadUntouched();
    expect(events).toEqual([]);
  });

  it('Expanded is recorded without counting the message delivered', async () => {
    addDispatch({ id: 'd-1' });

    const res = await post([report('op-d-1', 'Expanded')]);

    expect(res.status).toBe(200);
    expect(dispatch('d-1')).toMatchObject({ deliveryStatus: 'Expanded', deliveredAt: null, bouncedAt: null });
    expectLeadUntouched();
  });

  it('Failed with a bad-address reason is a hard bounce', async () => {
    addDispatch({ id: 'd-1' });

    const res = await post([report('op-d-1', 'Failed', '550 5.1.1 The email account that you tried to reach does not exist.')]);

    expect(res.status).toBe(200);
    expectHardBounce('d-1', 'Failed');
    expect(enrollment('enr-1').lastError).toContain('5.1.1');
  });

  it.each([
    ['a transient reason', '451 4.4.0 DNS lookup of the recipient domain timed out.'],
    ['a policy refusal', '550 5.7.1 Message rejected due to the sender\'s reputation.'],
    ['no reason at all', undefined],
  ])('Failed with %s is a soft bounce that leaves the lead mailable', async (_label, statusMessage) => {
    addDispatch({ id: 'd-1' });

    const res = await post([report('op-d-1', 'Failed', statusMessage)]);

    expect(res.status).toBe(200);
    expect(dispatch('d-1')).toMatchObject({ deliveryStatus: 'Failed', bounceType: 'soft', bouncedAt: new Date(ATTEMPTED_AT) });
    expectLeadUntouched();
    expect(events).toEqual([]);
  });

  it('logs a status ACS does not document and writes nothing', async () => {
    addDispatch({ id: 'd-1' });

    const res = await post([report('op-d-1', 'Deferred')]);

    expect(res.status).toBe(200);
    expect(dispatch('d-1')).toMatchObject({ deliveryStatus: null, bouncedAt: null, bounceType: null });
    expectLeadUntouched();
    expect(fake.emailDispatch.updateMany).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('unknown delivery status "Deferred"'));
  });

  it('records a bounce of a mailbox test send without touching any lead (L3)', async () => {
    addDispatch({ id: 'd-test', leadId: null, campaignId: null, messageId: 'op-test', operationId: null });

    const res = await post([report('op-test', 'Bounced')]);

    expect(res.status).toBe(200);
    expect(dispatch('d-test')).toMatchObject({ bounceType: 'hard' });
    expect(fake.lead.update).not.toHaveBeenCalled();
    expectLeadUntouched();
    expect(events).toEqual([{ messageId: 'op-test', eventType: 'bounce' }]);
  });

  it('never lets a later report overwrite a bounce, but lets a hard bounce replace a soft one', async () => {
    addDispatch({ id: 'd-1' });

    await post([report('op-d-1', 'Failed', '421 4.4.2 Connection dropped.')]);
    await post([report('op-d-1', 'Delivered')]);
    expect(dispatch('d-1')).toMatchObject({ deliveryStatus: 'Failed', bounceType: 'soft', deliveredAt: null });

    await post([report('op-d-1', 'Bounced')]);
    expectHardBounce('d-1', 'Bounced');

    await post([report('op-d-1', 'Failed', '421 4.4.2 Connection dropped.')]);
    expect(dispatch('d-1')).toMatchObject({ deliveryStatus: 'Bounced', bounceType: 'hard' });
  });
});

describe('webhook matching and Event Grid retries (M27)', () => {
  it('finds a campaign send by its operation id when the report arrives before the send is recorded', async () => {
    // Still Sending: the dispatch carries its synthetic id and the stored operation id.
    addDispatch({ id: 'd-1', messageId: 'cmp-1-lead-1-1-1741687000000', operationId: 'op-fast' });

    const res = await post([report('op-fast', 'Bounced')]);

    expect(res.status).toBe(200);
    expectHardBounce('d-1', 'Bounced');
  });

  it('matches an id wrapped in angle brackets and in another case', async () => {
    addDispatch({ id: 'd-1', operationId: 'op-mixed', messageId: 'op-mixed' });

    const res = await post([report(' <OP-MIXED> ', 'Delivered')]);

    expect(res.status).toBe(200);
    expect(dispatch('d-1').deliveredAt).toEqual(new Date(ATTEMPTED_AT));
  });

  it('acknowledges a report for a message it has no dispatch for with a 2xx and logs it', async () => {
    addDispatch({ id: 'd-1' });

    const res = await post([report('op-someone-else', 'Bounced')]);

    expect(res.status).toBe(200);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('No dispatch for message op-someone-else'));
    expect(dispatch('d-1').bounceType).toBeNull();
    expectLeadUntouched();
  });

  it('fails the batch when an event cannot be processed, applies the rest, and applies the failed one on redelivery', async () => {
    addDispatch({ id: 'd-1' });
    addDispatch({ id: 'd-2', leadId: 'lead-2' });
    fake.lead.update.mockRejectedValueOnce(new Error('Timed out fetching a new connection from the connection pool.'));
    const batch = [report('op-d-1', 'Bounced'), report('op-d-2', 'Delivered')];

    const first = await post(batch);

    // Event Grid redelivers a batch answered with a 5xx.
    expect(first.status).toBe(500);
    // The bounce's transaction rolled back as a whole, so nothing of it stuck.
    expect(dispatch('d-1')).toMatchObject({ deliveryStatus: null, bouncedAt: null, bounceType: null });
    expectLeadUntouched();
    expect(events).toEqual([]);
    expect(dispatch('d-2').deliveredAt).toEqual(new Date(ATTEMPTED_AT));

    const redelivered = await post(batch);

    expect(redelivered.status).toBe(200);
    expectHardBounce('d-1', 'Bounced');
    expect(dispatch('d-2')).toMatchObject({ deliveryStatus: 'Delivered', deliveredAt: new Date(ATTEMPTED_AT) });
  });

  it('applies a redelivered hard bounce once', async () => {
    addDispatch({ id: 'd-1' });

    expect((await post([report('op-d-1', 'Suppressed')])).status).toBe(200);
    expect((await post([report('op-d-1', 'Suppressed')])).status).toBe(200);

    expectHardBounce('d-1', 'Suppressed');
    expect(fake.lead.update).toHaveBeenCalledTimes(1);
    expect(fake.suppressedEmail.createMany).toHaveBeenCalledTimes(1);
  });
});

describe('classifyDeliveryFailure (H20)', () => {
  it.each([
    ['550 5.1.1 The email account that you tried to reach does not exist.', 'hard'],
    ['550 5.1.10 RESOLVER.ADR.RecipientNotFound; Recipient not found by SMTP address lookup', 'hard'],
    ['550 5.1.2 Host unknown: domain not found', 'hard'],
    ['550 Requested action not taken: mailbox unavailable', 'hard'],
    ['554 5.4.4 Unable to route: no MX record for the domain', 'hard'],
    ['Recipient address does not exist.', 'hard'],
    ['452 4.2.2 The email account that you tried to reach is over quota.', 'soft'],
    ['450 Requested mail action not taken: mailbox unavailable', 'soft'],
    ['550 5.7.1 Service unavailable; client host blocked. Mailbox unavailable.', 'soft'],
    ['552 5.2.2 Mailbox full', 'soft'],
    ['550 5.1.8 Bad sender address', 'soft'],
    ['The message could not be delivered in time.', 'soft'],
    ['', 'soft'],
    [null, 'soft'],
    [undefined, 'soft'],
  ])('%j is %s', (statusMessage, expected) => {
    expect(classifyDeliveryFailure(statusMessage)).toBe(expected);
  });
});

describe('parseDeliveryStatus (H20)', () => {
  it.each([
    ['Delivered', 'Delivered'],
    ['bounced', 'Bounced'],
    [' FilteredSpam ', 'FilteredSpam'],
    ['Deferred', null],
    [42, null],
    [undefined, null],
  ])('%j reads as %j', (status, expected) => {
    expect(parseDeliveryStatus(status)).toBe(expected);
  });
});
