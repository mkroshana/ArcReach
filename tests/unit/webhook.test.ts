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
  campaignStep: { findFirst: vi.fn() },
  emailEvent: { create: vi.fn() },
  suppressedEmail: { createMany: vi.fn() },
  $transaction: vi.fn(),
}));

vi.mock('../../lib/db', () => ({ prisma: fake }));

import { POST } from '../../app/api/webhook/route';
import { classifyDeliveryFailure, deliveryOutcome, isSenderRefusal, parseDeliveryStatus } from '../../lib/deliveryReport';

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

  describe('in production (M74)', () => {
    const handshake = [{ eventType: 'Microsoft.EventGrid.SubscriptionValidationEvent', data: { validationCode: 'abc-123' } }];

    beforeEach(() => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('NEXT_PHASE', undefined);
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it.each([
      'whsec_e9a182c38d4f7281',
      'whsec_placeholder_secret_key_12345',
      'my_webhook_secret_placeholder',
      '<output of: openssl rand -hex 32>',
      '<your webhook signature secret>',
    ])(
      'refuses every request while WEBHOOK_SECRET is the published or placeholder value %j, even with that header',
      async (published) => {
        process.env.WEBHOOK_SECRET = published;
        const res = await POST(makeReq(handshake, { 'x-arcreach-webhook-secret': published }));
        expect(res.status).toBe(500);
        expect((await res.json()).error).toMatch(/not configured/i);
      }
    );

    it('accepts the configured secret when it is not a published value', async () => {
      const res = await POST(makeReq(handshake, { 'x-arcreach-webhook-secret': 'test-secret-value' }));
      expect(res.status).toBe(200);
      expect((await res.json()).validationResponse).toBe('abc-123');
    });
  });
});

type DispatchRow = {
  id: string; leadId: string | null; campaignId: string | null; messageId: string; operationId: string | null;
  deliveryStatus: string | null; deliveredAt: Date | null; bouncedAt: Date | null; bounceType: string | null;
  stepOrder?: number | null; senderRefusedAt?: Date | null;
};
type LeadRow = { id: string; email: string; status: string; validationStatus: string };
type EnrollmentRow = {
  id: string; leadId: string; campaignId: string; status: string; nextActionDate: Date | null;
  lastError: string | null; lastBounceType: string | null;
  currentSequenceStep?: number; retryCount?: number;
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
  // Campaign cmp-1 has three steps; the others have none on record.
  fake.campaignStep.findFirst.mockImplementation(async ({ where }: any) =>
    (where.campaignId === 'cmp-1' && where.stepOrder >= 1 && where.stepOrder <= 3 ? { id: `step-${where.stepOrder}` } : null));
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

  it.each([
    ['a bad-address code', '550 5.1.1 The email account that you tried to reach does not exist; user unknown.'],
    ['no reason at all', undefined],
    ['a reason it does not recognise', '554 5.4.4 Unable to route the message.'],
    ['a bad-address code after a quoted IP address', '[10.2.1.1] 550 5.1.1 user unknown'],
  ])('Bounced with %s stays a hard bounce that suppresses the lead', async (_label, statusMessage) => {
    addDispatch({ id: 'd-1' });

    const res = await post([report('op-d-1', 'Bounced', statusMessage)]);

    expect(res.status).toBe(200);
    expectHardBounce('d-1', 'Bounced');
  });

  it.each([
    ['a suspected spam refusal', '550 5.7.1 [203.0.113.7] Gmail has detected that this message is likely suspected spam.'],
    ['an authentication refusal', '550-5.7.26 This mail has been blocked because the sender is unauthenticated.'],
    ['a transient rate limit', '421 4.7.28 Our system has detected an unusual rate of mail from your IP; rate limited.'],
    ['spam wording without a code', 'Message rejected as unsolicited mail.'],
    ['a spam refusal after a quoted IP address', '[5.1.1.4] 550 5.7.1 suspected spam'],
    ['a full mailbox', "552-5.2.2 The recipient's inbox is out of storage space."],
    ['a content filter refusal', '554 Denied by content filter'],
    ['a block list refusal', '550 Client host rejected: listed at dnsbl.example.net'],
  ])('Bounced with %s is a soft bounce that suppresses nobody and leaves the lead mailable', async (_label, statusMessage) => {
    addDispatch({ id: 'd-1' });

    const res = await post([report('op-d-1', 'Bounced', statusMessage)]);

    expect(res.status).toBe(200);
    expect(dispatch('d-1')).toMatchObject({ deliveryStatus: 'Bounced', bounceType: 'soft', bouncedAt: new Date(ATTEMPTED_AT) });
    expectLeadUntouched();
    expect(fake.suppressedEmail.createMany).not.toHaveBeenCalled();
    expect(fake.lead.update).not.toHaveBeenCalled();
    expect(events).toEqual([]);
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

describe('a report after Delivered replaces its status, which the Delivered metric goes by (stats A14)', () => {
  it.each([
    ['FilteredSpam', undefined, null],
    ['Quarantined', undefined, null],
    ['Failed', '421 4.4.2 Connection dropped.', 'soft'],
    ['Bounced', undefined, 'hard'],
  ])('%s leaves deliveredAt set, so lib/engagementMetrics counts the email by its new status alone', async (status, statusMessage, bounceType) => {
    addDispatch({ id: 'd-1' });

    await post([report('op-d-1', 'Delivered')]);
    const res = await post([report('op-d-1', status, statusMessage)]);

    expect(res.status).toBe(200);
    expect(dispatch('d-1')).toMatchObject({ deliveryStatus: status, deliveredAt: new Date(ATTEMPTED_AT), bounceType });
  });

  it('still suppresses the lead on a hard bounce after Delivered', async () => {
    addDispatch({ id: 'd-1' });

    await post([report('op-d-1', 'Delivered')]);
    await post([report('op-d-1', 'Bounced')]);

    expectHardBounce('d-1', 'Bounced');
  });

  it('sets the status back to Delivered when a Delivered report follows a spam one', async () => {
    addDispatch({ id: 'd-1' });

    await post([report('op-d-1', 'FilteredSpam')]);
    await post([report('op-d-1', 'Delivered')]);

    expect(dispatch('d-1')).toMatchObject({ deliveryStatus: 'Delivered', deliveredAt: new Date(ATTEMPTED_AT), bounceType: null });
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
    expect(deliveryOutcome('Failed', statusMessage)).toBe(expected);
  });
});

describe('deliveryOutcome for Bounced and Suppressed (H20)', () => {
  it.each([
    ['550 5.7.1 Message rejected: suspected spam', 'soft'],
    ['550-5.7.26 Unauthenticated email from example.com is not accepted due to its DMARC policy', 'soft'],
    ['421 4.7.28 rate limited', 'soft'],
    ['452 4.2.2 The email account that you tried to reach is over quota.', 'soft'],
    ['451 Temporary local problem, try again later', 'soft'],
    ['554 Your IP address is listed on a blocklist', 'soft'],
    ['550 Sender reputation too low', 'soft'],
    ['550 SPF check failed', 'soft'],
    ['550 Message failed DKIM verification', 'soft'],
    ['550 Too many messages from your IP address', 'soft'],
    ['550 Mailbox unavailable: client host blocked', 'soft'],
    ['550 5.1.1 The email account that you tried to reach does not exist.', 'hard'],
    ['550 5.1.10 RESOLVER.ADR.RecipientNotFound; Recipient not found by SMTP address lookup', 'hard'],
    ['550 5.1.1 Recipient rejected by policy: user unknown', 'hard'],
    ['Recipient address does not exist.', 'hard'],
    ['554 5.4.4 Unable to route: no MX record for the domain', 'hard'],
    ['552 5.2.2 Mailbox full', 'soft'],
    ['552 5.2.2 Requested mail action aborted: mailbox unavailable', 'soft'],
    ['', 'hard'],
    [null, 'hard'],
    [undefined, 'hard'],
  ])('Bounced %j is %s', (statusMessage, expected) => {
    expect(deliveryOutcome('Bounced', statusMessage)).toBe(expected);
  });

  it.each(['550 5.7.1 Message rejected: suspected spam', '421 4.7.28 rate limited', null])(
    'Suppressed %j is hard whatever its reason',
    (statusMessage) => {
      expect(deliveryOutcome('Suppressed', statusMessage)).toBe('hard');
    }
  );

  it.each([
    'Message rejected as junk',
    '550 Message identified as phishing',
    '554 Denied by content filter',
    '550 Rejected by our content filter',
    '550 Message filtered',
    '550 Your server is listed at bl.example.net',
    '554 Sending host found on a DNSBL',
    '550 Client host rejected by RBL',
    '550 Sender IP is on our blocklist',
    '550 Message content not accepted',
    '554 Content rejected',
  ])('Bounced %j over spam, a content filter or a block list is soft', (statusMessage) => {
    expect(deliveryOutcome('Bounced', statusMessage)).toBe('soft');
  });

  it.each([
    "552-5.2.2 The recipient's inbox is out of storage space.",
    '452 4.2.2 The email account that you tried to reach is over quota.',
    '550 Mailbox full',
    'Recipient mailbox is full',
    '550 User over quota',
    '552 Insufficient storage',
    '552 The recipient is out of storage',
  ])('Bounced %j over a full mailbox is soft, as it is for Failed', (statusMessage) => {
    expect(deliveryOutcome('Bounced', statusMessage)).toBe('soft');
    expect(deliveryOutcome('Failed', statusMessage)).toBe('soft');
  });

  it.each([
    '550 5.1.1 user unknown',
    '550-5.1.1 The email account that you tried to reach does not exist.',
    '550 5.1.2 Host unknown: domain not found',
    '553 5.1.3 Invalid recipient address syntax',
    '550 5.1.1 user unknown; message filtered by content filter',
    '550 5.1.1 mailbox full',
    'No such user here',
    'Recipient address does not exist.',
  ])('Bounced %j naming a bad address, and no refusal of the sender without a code, stays hard', (statusMessage) => {
    expect(deliveryOutcome('Bounced', statusMessage)).toBe('hard');
  });
});

describe('enhanced status code parsing (H20)', () => {
  // Each of these used to be read by the first x.y.z in the message, which
  // was part of an IP address or a version number, not the server's code.
  it.each([
    ['[5.1.1.4] 550 5.7.1 suspected spam', 'soft', 'soft'],
    ['[5.1.1.4] 550 5.7.1 Message refused', 'soft', 'soft'],
    ['[192.5.1.1] 550-5.7.1 Message refused', 'soft', 'soft'],
    ['Remote host [192.5.1.1] said: 5.7.1 Message refused', 'soft', 'soft'],
    ['[10.2.1.1] 550 5.1.1 user unknown', 'hard', 'hard'],
    ['Remote host [4.4.7.9] said: 5.1.1 user unknown', 'hard', 'hard'],
    ['Postfix 2.10.1: 550 5.1.1 user unknown', 'hard', 'hard'],
  ])('never reads a dotted IP address or other number in %j as its code (Bounced %s, Failed %s)', (statusMessage, bounced, failed) => {
    expect(deliveryOutcome('Bounced', statusMessage)).toBe(bounced);
    expect(deliveryOutcome('Failed', statusMessage)).toBe(failed);
    expect(classifyDeliveryFailure(statusMessage)).toBe(failed);
  });

  // Codes that were read correctly before keep the same outcome for Failed.
  it.each([
    ['550 5.7.1 [203.0.113.7] Message refused', 'soft'],
    ['550-5.1.1 <jane@example.com> user unknown [198.51.100.25]', 'hard'],
    ['421-4.7.0 [40.107.22.5 15] Try again later', 'soft'],
    ['#550 5.1.1 RESOLVER.ADR.RecipNotFound; not found ##', 'hard'],
    ['5.1.1 user unknown', 'hard'],
    ['smtp;550 5.1.10 RecipientNotFound', 'hard'],
    ['550 5.2.1 Mailbox disabled', 'soft'],
    ['550 5.1.8 Bad sender address [192.0.2.44]', 'soft'],
    ['554 5.4.4 [10.0.0.12] Unable to route: domain not found', 'hard'],
    ['450 4.2.0 [2001:db8::1] Mailbox busy', 'soft'],
    ['Delivery failed after 5.5 hours', 'soft'],
  ])('Failed %j keeps its outcome (%s)', (statusMessage, expected) => {
    expect(classifyDeliveryFailure(statusMessage)).toBe(expected);
    expect(deliveryOutcome('Failed', statusMessage)).toBe(expected);
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

describe('isSenderRefusal', () => {
  it('is true for a permanent policy refusal: spam, reputation, a block list or authentication', () => {
    for (const message of [
      '550-5.7.1 Gmail has detected that this message is likely suspicious due to the very low reputation of the sending domain.',
      '550-5.7.1 Gmail has detected that this message is likely unsolicited mail.',
      '550-5.7.26 This mail has been blocked because the sender is unauthenticated.',
      '550 5.7.1 Service unavailable, client host blocked using a block list (S3150).',
      '554 Message rejected as spam by content filter',
      'Rejected: sender has a poor reputation',
    ]) {
      expect(isSenderRefusal('Bounced', message)).toBe(true);
      expect(isSenderRefusal('Failed', message)).toBe(true);
    }
  });

  it('is true for FilteredSpam whatever its message', () => {
    expect(isSenderRefusal('FilteredSpam')).toBe(true);
    expect(isSenderRefusal('FilteredSpam', '')).toBe(true);
  });

  it('is false for a temporary refusal, a rate limit among them: the same mailbox may be accepted later', () => {
    for (const message of [
      '421-4.7.28 Gmail has detected an unusual rate of unsolicited mail originating from your SPF domain.',
      '451 4.7.1 Greylisted, please try again later',
      '421 Too many connections from your host',
      'Rate limit exceeded, too many messages',
    ]) {
      expect(isSenderRefusal('Bounced', message)).toBe(false);
      expect(isSenderRefusal('Failed', message)).toBe(false);
    }
  });

  it('is false for a full mailbox, a bad address, a failure with no reason, and other statuses', () => {
    expect(isSenderRefusal('Bounced', '552 5.2.2 Mailbox full')).toBe(false);
    expect(isSenderRefusal('Failed', 'The mailbox is full and blocked from receiving')).toBe(false);
    expect(isSenderRefusal('Bounced', '550 5.1.1 The email account that you tried to reach does not exist')).toBe(false);
    expect(isSenderRefusal('Failed', 'No such user here, message blocked')).toBe(false);
    expect(isSenderRefusal('Failed', '554 5.4.14 Hop count exceeded')).toBe(false);
    expect(isSenderRefusal('Failed')).toBe(false);
    expect(isSenderRefusal('Failed', null)).toBe(false);
    for (const status of ['Delivered', 'Expanded', 'Quarantined', 'Suppressed'] as const) {
      expect(isSenderRefusal(status, '550 5.7.1 blocked as spam')).toBe(false);
    }
  });
});

describe('a report that the sender was refused sends the step again (soft-bounce retry)', () => {
  const REFUSED = '550-5.7.1 Gmail has detected that this message is likely suspicious due to the very low reputation of the sending domain.';
  const AT = new Date(ATTEMPTED_AT);
  /** Lead 1 got step `sentStep` of cmp-1 as dispatch d1 and now waits for `waitingFor`. */
  function sent(sentStep: number, waitingFor: number, status = 'Active') {
    addDispatch({ id: 'd1', stepOrder: sentStep });
    Object.assign(enrollment('enr-1'), { status, currentSequenceStep: waitingFor, nextActionDate: status === 'Active' ? DUE : null, retryCount: 2 });
  }

  it('marks the email refused, keeps the address mailable and puts the lead back on that step, due now', async () => {
    sent(1, 2);

    const res = await post([report('op-d1', 'Bounced', REFUSED)]);

    expect(res.status).toBe(200);
    expect(dispatch('d1')).toMatchObject({ deliveryStatus: 'Bounced', bounceType: 'soft', bouncedAt: AT, senderRefusedAt: AT });
    expect(enrollment('enr-1')).toMatchObject({ status: 'Active', currentSequenceStep: 1, nextActionDate: AT, retryCount: 0 });
    // The lead itself is fine: not bounced, not suppressed, and its other campaigns go on.
    expect(lead('lead-1')).toMatchObject({ status: 'Neutral', validationStatus: 'Valid' });
    expect(suppressed).toEqual([]);
    expect(enrollment('enr-2')).toMatchObject({ status: 'Active', nextActionDate: DUE });
  });

  it('does the same for a Failed report and for one filtered as spam', async () => {
    sent(2, 3);
    await post([report('op-d1', 'Failed', REFUSED)]);
    expect(dispatch('d1')).toMatchObject({ bounceType: 'soft', senderRefusedAt: AT });
    expect(enrollment('enr-1')).toMatchObject({ currentSequenceStep: 2, nextActionDate: AT });

    addDispatch({ id: 'd2', stepOrder: 2 });
    Object.assign(enrollment('enr-1'), { currentSequenceStep: 3, nextActionDate: DUE });
    await post([report('op-d2', 'FilteredSpam')]);
    // Filtered is no bounce, so only the refusal is recorded beside its status.
    expect(dispatch('d2')).toMatchObject({ deliveryStatus: 'FilteredSpam', bounceType: null, bouncedAt: null, senderRefusedAt: AT });
    expect(enrollment('enr-1')).toMatchObject({ currentSequenceStep: 2, nextActionDate: AT });
  });

  it('reopens an enrollment the refused email completed, when it was the last step', async () => {
    sent(3, 3, 'Completed');

    await post([report('op-d1', 'Bounced', REFUSED)]);

    expect(enrollment('enr-1')).toMatchObject({ status: 'Active', currentSequenceStep: 3, nextActionDate: AT });
  });

  it('leaves the sequence as it is for a soft bounce that says nothing against the sender', async () => {
    for (const [status, message] of [
      ['Bounced', '421-4.7.28 Gmail has detected an unusual rate of unsolicited mail originating from your SPF domain.'],
      ['Bounced', '552 5.2.2 Mailbox full'],
      ['Failed', 'Connection timed out'],
      ['Quarantined', undefined],
    ] as const) {
      dispatches = [];
      sent(1, 2);
      await post([report('op-d1', status, message)]);
      expect(dispatch('d1').senderRefusedAt ?? null).toBeNull();
      expect(enrollment('enr-1')).toMatchObject({ status: 'Active', currentSequenceStep: 2, nextActionDate: DUE, retryCount: 2 });
    }
  });

  it('leaves an enrollment that has moved on or left the sequence since the email', async () => {
    // Already two steps on
    sent(1, 3);
    await post([report('op-d1', 'Bounced', REFUSED)]);
    expect(dispatch('d1')).toMatchObject({ senderRefusedAt: AT });
    expect(enrollment('enr-1')).toMatchObject({ currentSequenceStep: 3, nextActionDate: DUE });

    // Paused by a reply, then a refusal of an earlier email arrives
    dispatches = [];
    sent(1, 2, 'Paused');
    await post([report('op-d1', 'Bounced', REFUSED)]);
    expect(enrollment('enr-1')).toMatchObject({ status: 'Paused', currentSequenceStep: 2 });

    // Completed, but not by this email: step 1 of three
    dispatches = [];
    sent(1, 3, 'Completed');
    await post([report('op-d1', 'Bounced', REFUSED)]);
    expect(enrollment('enr-1')).toMatchObject({ status: 'Completed', currentSequenceStep: 3 });
  });

  it('queues the step once when Event Grid delivers the report again', async () => {
    sent(1, 2);
    await post([report('op-d1', 'Bounced', REFUSED)]);
    // The send engine has sent the step again from another mailbox and moved the lead on.
    Object.assign(enrollment('enr-1'), { currentSequenceStep: 2, nextActionDate: DUE });

    await post([report('op-d1', 'Bounced', REFUSED)]);
    await post([report('op-d1', 'FilteredSpam')]);

    expect(enrollment('enr-1')).toMatchObject({ currentSequenceStep: 2, nextActionDate: DUE });
  });

  it('only marks an email with no step: a mailbox test or a Unibox reply', async () => {
    addDispatch({ id: 'd1', leadId: null, campaignId: null, stepOrder: null });

    await post([report('op-d1', 'Bounced', REFUSED)]);

    expect(dispatch('d1')).toMatchObject({ bounceType: 'soft', senderRefusedAt: AT });
    expect(fake.campaignStep.findFirst).not.toHaveBeenCalled();
    expect(enrollments.map((e) => e.status)).toEqual(['Active', 'Active', 'Completed']);
  });

  it('marks nothing when queueing the step fails, so the redelivered report does both', async () => {
    sent(1, 2);
    fake.campaignEnrollment.updateMany.mockRejectedValueOnce(new Error('database unavailable'));

    const failed = await post([report('op-d1', 'Bounced', REFUSED)]);
    expect(failed.status).not.toBe(200);
    expect(dispatch('d1')).toMatchObject({ bounceType: null, bouncedAt: null });
    expect(dispatch('d1').senderRefusedAt ?? null).toBeNull();

    await post([report('op-d1', 'Bounced', REFUSED)]);
    expect(dispatch('d1')).toMatchObject({ bounceType: 'soft', senderRefusedAt: AT });
    expect(enrollment('enr-1')).toMatchObject({ currentSequenceStep: 1, nextActionDate: AT });
  });
});
