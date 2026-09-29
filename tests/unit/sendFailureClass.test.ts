import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * One in-memory campaign, enrollment, lead and dispatch. The fakes apply the
 * writes handleSendFailure makes, so the tests check what each failure class
 * really leaves behind.
 */
const fake = vi.hoisted(() => ({
  campaign: { updateMany: vi.fn() },
  campaignEnrollment: { update: vi.fn() },
  lead: { update: vi.fn() },
  emailDispatch: { update: vi.fn() },
  emailEvent: { create: vi.fn() },
  $transaction: vi.fn(),
}));

vi.mock('../../lib/db', () => ({ prisma: fake }));

import { handleSendFailure, MAX_CONSECUTIVE_QUOTA_FAILURES, MAX_SEND_ATTEMPTS } from '../../lib/sendEngine';
import { sendMessage, EmailConfigError, EmailSendError } from '../../lib/emailProvider';

const HOUR_MS = 60 * 60 * 1000;

let campaign: { id: string; status: string; pausedUntil: Date | null; pauseReason: string | null };
let enrollment: {
  id: string; status: string; retryCount: number; quotaFailures: number; nextActionDate: Date | null;
  lastError: string | null; lastBounceType: string | null; claimToken: string | null; claimedAt: Date | null;
};
let lead: { id: string; email: string; status: string; validationStatus: string };
let dispatch: { id: string; messageId: string; status: string };

function apply(row: Record<string, any>, data: Record<string, any>) {
  for (const [key, value] of Object.entries(data)) {
    row[key] = value !== null && typeof value === 'object' && 'increment' in value ? row[key] + value.increment : value;
  }
}

const fail = (err: unknown) =>
  handleSendFailure(
    { id: enrollment.id, retryCount: enrollment.retryCount, quotaFailures: enrollment.quotaFailures },
    { id: lead.id, email: lead.email },
    dispatch,
    err,
    'Launch',
    campaign.id
  );

/** The auto-resume an hour after the engine paused the campaign. */
const resume = () => Object.assign(campaign, { status: 'Active', pausedUntil: null, pauseReason: null });

/** What a send under a connection string saved with another SECRETS_KEY throws. */
const undecryptableConnString = () =>
  sendMessage(
    { to: 'lead@prospect.test', subject: 's', body: 'b', isHtml: false, sender: { emailAddress: 'one@acme.test' } },
    { activeProvider: 'AZURE', azureConnString: 'enc:v1:saved-under-another-key', azureSenderDomains: ['acme.test'] }
  ).catch((e) => e);

/** What a send under a connection string the Azure SDK cannot parse (only the access key was pasted) throws. */
const unparsableConnString = () =>
  sendMessage(
    { to: 'lead@prospect.test', subject: 's', body: 'b', isHtml: false, sender: { emailAddress: 'one@acme.test' } },
    { activeProvider: 'AZURE', azureConnString: 'a2V5', azureSenderDomains: ['acme.test'] }
  ).catch((e) => e);

/** What a send from a mailbox on a domain missing from the verified list throws. */
const unverifiedDomain = () =>
  sendMessage(
    { to: 'lead@prospect.test', subject: 's', body: 'b', isHtml: false, sender: { emailAddress: 'one@gmail.com' } },
    { activeProvider: 'AZURE', azureConnString: 'endpoint=https://acs.test/;accesskey=a2V5', azureSenderDomains: ['acme.test'] }
  ).catch((e) => e);

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});

  campaign = { id: 'cmp-1', status: 'Active', pausedUntil: null, pauseReason: null };
  // The last attempt a soft failure allows: one more would fail the lead.
  enrollment = {
    id: 'enr-1', status: 'Active', retryCount: MAX_SEND_ATTEMPTS - 1, quotaFailures: 0, nextActionDate: new Date(0),
    lastError: null, lastBounceType: null, claimToken: 'worker', claimedAt: new Date(),
  };
  lead = { id: 'lead-1', email: 'lead@prospect.test', status: 'Neutral', validationStatus: 'Valid' };
  dispatch = { id: 'dispatch-1', messageId: 'msg-1', status: 'Sending' };

  fake.campaign.updateMany.mockImplementation(async ({ where, data }: any) => {
    const hit = where.id === campaign.id && where.status === campaign.status;
    if (hit) Object.assign(campaign, data);
    return { count: hit ? 1 : 0 };
  });
  fake.campaignEnrollment.update.mockImplementation(async ({ data }: any) => apply(enrollment, data));
  fake.lead.update.mockImplementation(async ({ data }: any) => Object.assign(lead, data));
  fake.emailDispatch.update.mockImplementation(async ({ data }: any) => Object.assign(dispatch, data));
  fake.$transaction.mockImplementation(async (writes: Promise<unknown>[]) => Promise.all(writes));
});

describe('a systemic send failure pauses the campaign and never penalises the lead (H9)', () => {
  it.each<[string, () => unknown]>([
    ['a connection string that cannot be decrypted', undecryptableConnString],
    ['a connection string that cannot be parsed', unparsableConnString],
    ['a sender domain missing from the verified list', unverifiedDomain],
    ['ACS refusing the access key (401)', () => new EmailSendError('Denied by the resource provider.', { statusCode: 401, code: 'Denied' })],
    ['ACS refusing access (403)', () => new EmailSendError('Forbidden.', { statusCode: 403 })],
    ['a sender domain not linked to the ACS resource', () => new EmailSendError('The specified sender domain has not been linked.', { statusCode: 404, code: 'DomainNotLinked' })],
  ])('on %s', async (_label, makeError) => {
    const err = await makeError();
    const before = Date.now();

    expect(await fail(err)).toEqual({ action: 'break' });

    expect(campaign).toMatchObject({ status: 'Paused', pauseReason: 'config' });
    expect(campaign.pausedUntil!.getTime() - before).toBeGreaterThanOrEqual(HOUR_MS);
    expect(campaign.pausedUntil!.getTime() - before).toBeLessThan(HOUR_MS + 5_000);
    // The enrollment waits out the pause with its retries, streak and last error untouched.
    expect(enrollment).toMatchObject({
      status: 'Active', retryCount: MAX_SEND_ATTEMPTS - 1, quotaFailures: 0, nextActionDate: campaign.pausedUntil,
      lastError: null, lastBounceType: null, claimToken: null, claimedAt: null,
    });
    expect(lead).toMatchObject({ status: 'Neutral', validationStatus: 'Valid' });
    expect(fake.lead.update).not.toHaveBeenCalled();
    expect(fake.emailEvent.create).not.toHaveBeenCalled();
    expect(dispatch.status).toBe('Failed');
  });

  it('records a clock-skew rejection as the systemic (server clock) pause', async () => {
    const err = new EmailSendError(
      'The time difference between the originating client and the server is greater than the allowed margin of 5 minutes.',
      { statusCode: 401 }
    );

    await fail(err);

    expect(campaign).toMatchObject({ status: 'Paused', pauseReason: 'systemic' });
    expect(enrollment.retryCount).toBe(MAX_SEND_ATTEMPTS - 1);
    expect(fake.lead.update).not.toHaveBeenCalled();
  });

  it('keeps pausing, never failing the lead, however long the misconfiguration lasts', async () => {
    for (let hour = 0; hour < MAX_CONSECUTIVE_QUOTA_FAILURES + MAX_SEND_ATTEMPTS; hour++) {
      resume();
      await fail(new EmailConfigError('Azure Communication Services connection string or verified sender domains are not configured.'));
    }

    expect(campaign.status).toBe('Paused');
    expect(enrollment).toMatchObject({ status: 'Active', retryCount: MAX_SEND_ATTEMPTS - 1, quotaFailures: 0 });
    expect(fake.lead.update).not.toHaveBeenCalled();
  });
});

describe('quota refusals pause the campaign; only worded ones count against a lead they keep landing on (M2)', () => {
  const tooManyRequests = () => new EmailSendError('Slow down.', { statusCode: 429, code: 'TooManyRequests' });
  /** A quota refusal known only from its wording, which may really be about the lead. */
  const wordedQuota = () => new Error('Quota limit exceeded');

  it('pauses on a 429 whose message has no quota words, leaving the retries and the streak alone', async () => {
    expect(await fail(tooManyRequests())).toEqual({ action: 'break' });

    expect(campaign).toMatchObject({ status: 'Paused', pauseReason: 'quota' });
    expect(enrollment).toMatchObject({ status: 'Active', retryCount: MAX_SEND_ATTEMPTS - 1, quotaFailures: 0, lastBounceType: null });
    expect(fake.lead.update).not.toHaveBeenCalled();
  });

  it("never counts ACS's own 429 or quota code against the lead, however many land on it", async () => {
    enrollment.quotaFailures = MAX_CONSECUTIVE_QUOTA_FAILURES;
    for (let hour = 0; hour < MAX_CONSECUTIVE_QUOTA_FAILURES + MAX_SEND_ATTEMPTS; hour++) {
      resume();
      const err = hour % 2 ? tooManyRequests() : new EmailSendError('Request refused.', { code: 'QuotaExceeded' });
      expect(await fail(err)).toEqual({ action: 'break' });
      expect(campaign).toMatchObject({ status: 'Paused', pauseReason: 'quota' });
    }

    expect(enrollment).toMatchObject({ status: 'Active', retryCount: MAX_SEND_ATTEMPTS - 1, quotaFailures: MAX_CONSECUTIVE_QUOTA_FAILURES });
    expect(fake.lead.update).not.toHaveBeenCalled();
  });

  it(`handles the worded refusal after ${MAX_CONSECUTIVE_QUOTA_FAILURES} in a row as a soft failure of the lead`, async () => {
    enrollment.retryCount = 0;
    for (let hour = 1; hour <= MAX_CONSECUTIVE_QUOTA_FAILURES; hour++) {
      resume();
      expect(await fail(wordedQuota())).toEqual({ action: 'break' });
      expect(campaign).toMatchObject({ status: 'Paused', pauseReason: 'quota' });
      expect(enrollment).toMatchObject({ retryCount: 0, quotaFailures: hour });
    }

    resume();
    expect(await fail(wordedQuota())).toEqual({ action: 'continue' });

    expect(campaign).toMatchObject({ status: 'Active', pauseReason: null });
    expect(enrollment).toMatchObject({
      status: 'Active', retryCount: 1, quotaFailures: MAX_CONSECUTIVE_QUOTA_FAILURES + 1, lastBounceType: 'soft', lastError: 'Quota limit exceeded',
    });
    expect(enrollment.nextActionDate!.getTime()).toBeGreaterThan(Date.now());
  });

  it('fails the enrollment and marks the lead Risky once an escalated streak uses up its retries', async () => {
    enrollment.quotaFailures = MAX_CONSECUTIVE_QUOTA_FAILURES;

    expect(await fail(wordedQuota())).toEqual({ action: 'continue' });

    expect(campaign.status).toBe('Active');
    expect(enrollment).toMatchObject({ status: 'Failed', nextActionDate: null, quotaFailures: 0, lastBounceType: 'soft', lastError: 'Quota limit exceeded' });
    expect(lead.validationStatus).toBe('Risky');
    expect(fake.emailEvent.create).toHaveBeenCalledWith({ data: { messageId: 'msg-1', eventType: 'send_failed' } });
  });

  it('ends the streak on any other soft failure', async () => {
    enrollment.retryCount = 0;
    enrollment.quotaFailures = MAX_CONSECUTIVE_QUOTA_FAILURES - 1;

    await fail(new Error('Connection timed out ETIMEDOUT'));
    expect(enrollment).toMatchObject({ retryCount: 1, quotaFailures: 0 });

    // The next quota refusal pauses the campaign again instead of counting against the lead.
    expect(await fail(wordedQuota())).toEqual({ action: 'break' });
    expect(campaign).toMatchObject({ status: 'Paused', pauseReason: 'quota' });
    expect(enrollment).toMatchObject({ retryCount: 1, quotaFailures: 1 });
  });

  it("treats a recipient's full mailbox as the lead's soft failure without pausing the campaign", async () => {
    enrollment.retryCount = 0;

    expect(await fail(new Error('Mailbox quota exceeded'))).toEqual({ action: 'continue' });

    expect(campaign).toMatchObject({ status: 'Active', pausedUntil: null, pauseReason: null });
    expect(enrollment).toMatchObject({ retryCount: 1, quotaFailures: 0, lastBounceType: 'soft' });
  });
});
