import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { checkSendingWindow, getEffectiveDailyCap, getMailboxCap, resolveCampaignSenders, resolveSenderRoutes, pickSender, classifyFailure } from '../../lib/sendEngine';
import { personalizeEmail } from '../../lib/personalize';
import { sendMessage, EmailConfigError, EmailSendError } from '../../lib/emailProvider';

describe('sendEngine', () => {
  describe('checkSendingWindow', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should return false if no schedule is specified', () => {
      expect(checkSendingWindow('UTC', null)).toBe(false);
    });

    it('should return true if current time is within allowed schedule', () => {
      // Set time to Monday, 10:00 AM UTC (2026-06-08T10:00:00Z is a Monday)
      vi.setSystemTime(new Date('2026-06-08T10:00:00Z'));
      const schedule = {
        days: ['Mon', 'Tue', 'Wed'],
        window: { start: '09:00', end: '17:00' }
      };
      expect(checkSendingWindow('UTC', schedule)).toBe(true);
    });

    it('should return false if day is not allowed', () => {
      // Sunday (2026-06-07T10:00:00Z is a Sunday)
      vi.setSystemTime(new Date('2026-06-07T10:00:00Z'));
      const schedule = {
        days: ['Mon', 'Tue', 'Wed'],
        window: { start: '09:00', end: '17:00' }
      };
      expect(checkSendingWindow('UTC', schedule)).toBe(false);
    });

    it('should return false if time is before start window', () => {
      // Monday 08:00 AM UTC
      vi.setSystemTime(new Date('2026-06-08T08:00:00Z'));
      const schedule = {
        days: ['Mon'],
        window: { start: '09:00', end: '17:00' }
      };
      expect(checkSendingWindow('UTC', schedule)).toBe(false);
    });

    it('should return false if time is after end window', () => {
      // Monday 06:00 PM UTC
      vi.setSystemTime(new Date('2026-06-08T18:00:00Z'));
      const schedule = {
        days: ['Mon'],
        window: { start: '09:00', end: '17:00' }
      };
      expect(checkSendingWindow('UTC', schedule)).toBe(false);
    });
  });

  describe('personalizeEmail', () => {
    it('should replace firstName and company placeholders', () => {
      const template = 'Hello {{firstName}}, how is {{company}}?';
      const lead = { name: 'John Doe', company: 'Acme Corp' };
      const output = personalizeEmail(template, lead);
      expect(output).toBe('Hello John, how is Acme Corp?');
    });

    it('should handle n8n style variables with fallback', () => {
      const template = 'Hey {{ $json.name || \'there\' }}, check out {{ $json.company || \'your business\' }}!';
      const lead = { name: 'John Doe', company: '' };
      const output = personalizeEmail(template, lead);
      expect(output).toBe("Hey John, check out your business!");
    });

    it('should resolve simple spintax options', () => {
      const template = '{Hi|Hello} {{firstName}}';
      const lead = { name: 'John' };
      const output = personalizeEmail(template, lead);
      expect(['Hi John', 'Hello John']).toContain(output);
    });
  });

  describe('getEffectiveDailyCap', () => {
    const sender = {
      warmupEnabled: true,
      warmupStartedAt: new Date('2026-06-01T12:00:00Z'),
      dailyLimit: 200,
      warmupLimit: 50,
      warmupRamp: 10
    };

    it('should return dailyLimit if warmup is disabled', () => {
      const disabledSender = { ...sender, warmupEnabled: false };
      const now = new Date('2026-06-05T12:00:00Z');
      expect(getEffectiveDailyCap(disabledSender, now)).toBe(200);
    });

    it('should return dailyLimit if warmupStartedAt is null', () => {
      const noStartSender = { ...sender, warmupStartedAt: null };
      const now = new Date('2026-06-05T12:00:00Z');
      expect(getEffectiveDailyCap(noStartSender, now)).toBe(200);
    });

    it('should return starting warmupLimit on Day 0 (less than 24h elapsed)', () => {
      const now = new Date('2026-06-01T18:00:00Z'); // 6 hours later
      expect(getEffectiveDailyCap(sender, now)).toBe(50);
    });

    it('should calculate ramp correctly on Day 1 (24h to 48h elapsed)', () => {
      const now = new Date('2026-06-02T13:00:00Z'); // 25 hours later
      expect(getEffectiveDailyCap(sender, now)).toBe(60); // 50 + 10 * 1
    });

    it('should calculate ramp correctly on Day 5', () => {
      const now = new Date('2026-06-06T15:00:00Z'); // 5 days + 3 hours later
      expect(getEffectiveDailyCap(sender, now)).toBe(100); // 50 + 10 * 5
    });

    it('should clamp cap to dailyLimit when calculation exceeds it', () => {
      const now = new Date('2026-06-30T12:00:00Z'); // 29 days later
      expect(getEffectiveDailyCap(sender, now)).toBe(200); // 50 + 10 * 29 = 340, clamped to 200
    });
  });

  describe('getMailboxCap', () => {
    const sender = {
      warmupEnabled: true,
      warmupStartedAt: new Date('2026-06-01T12:00:00Z'),
      dailyLimit: 200,
      warmupLimit: 50,
      warmupRamp: 10
    };
    const day5 = new Date('2026-06-06T15:00:00Z');
    const day29 = new Date('2026-06-30T12:00:00Z');

    it('is the effective daily cap while the daily limits apply', () => {
      expect(getMailboxCap(sender, day5, false)).toBe(100);
      expect(getMailboxCap(sender, day29, false)).toBe(200);
      expect(getMailboxCap({ ...sender, warmupEnabled: false }, day5, false)).toBe(200);
    });

    it('is the warmup ramp alone with the daily limits off, which the daily limit no longer clamps', () => {
      expect(getMailboxCap(sender, day5, true)).toBe(100);
      expect(getMailboxCap(sender, day29, true)).toBe(340); // 50 + 10 * 29
    });

    it('is null with the daily limits off for a mailbox that is not warming up', () => {
      expect(getMailboxCap({ ...sender, warmupEnabled: false }, day5, true)).toBeNull();
      expect(getMailboxCap({ ...sender, warmupStartedAt: null }, day5, true)).toBeNull();
    });
  });

  describe('resolveCampaignSenders', () => {
    it('should return primary sender when pool is empty', () => {
      const campaign = {
        userId: 'user-1',
        senderAccountId: 'acc-1',
        senderAccount: { id: 'acc-1', userId: 'user-1', emailAddress: 'acc1@test.com' },
        senders: []
      };
      const result = resolveCampaignSenders(campaign);
      expect(result).toEqual({ pool: [{ id: 'acc-1', userId: 'user-1', emailAddress: 'acc1@test.com' }], foreign: [] });
    });

    it('should return pool senders when pool is populated', () => {
      const campaign = {
        userId: 'user-1',
        senderAccountId: 'acc-1',
        senderAccount: { id: 'acc-1', userId: 'user-1', emailAddress: 'acc1@test.com' },
        senders: [
          { senderAccount: { id: 'acc-2', userId: 'user-1', emailAddress: 'acc2@test.com' } },
          { senderAccount: { id: 'acc-3', userId: 'user-1', emailAddress: 'acc3@test.com' } }
        ]
      };
      const result = resolveCampaignSenders(campaign);
      expect(result).toEqual({
        pool: [
          { id: 'acc-2', userId: 'user-1', emailAddress: 'acc2@test.com' },
          { id: 'acc-3', userId: 'user-1', emailAddress: 'acc3@test.com' }
        ],
        foreign: []
      });
    });

    // H24: a campaign never sends from a mailbox its owner does not own.
    const own = (id: string) => ({ id, userId: 'user-1', emailAddress: `${id}@test.com` });
    const other = (id: string) => ({ id, userId: 'user-2', emailAddress: `${id}@test.com` });

    it("should leave other users' mailboxes out of the pool", () => {
      const result = resolveCampaignSenders({
        userId: 'user-1',
        senderAccount: own('acc-1'),
        senders: [{ senderAccount: other('acc-2') }, { senderAccount: own('acc-3') }]
      });
      expect(result).toEqual({ pool: [own('acc-3')], foreign: [other('acc-2')] });
    });

    it('should fall back to an owned primary sender when every pool mailbox belongs to someone else', () => {
      const result = resolveCampaignSenders({
        userId: 'user-1',
        senderAccount: own('acc-1'),
        senders: [{ senderAccount: other('acc-2') }]
      });
      expect(result).toEqual({ pool: [own('acc-1')], foreign: [other('acc-2')] });
    });

    it('should return an empty pool, listing each foreign mailbox once, when the owner owns none of them', () => {
      expect(resolveCampaignSenders({ userId: 'user-1', senderAccount: other('acc-1'), senders: [] }))
        .toEqual({ pool: [], foreign: [other('acc-1')] });
      expect(resolveCampaignSenders({
        userId: 'user-1',
        senderAccount: other('acc-1'),
        senders: [{ senderAccount: other('acc-1') }, { senderAccount: other('acc-2') }]
      })).toEqual({ pool: [], foreign: [other('acc-1'), other('acc-2')] });
    });
  });

  describe('resolveSenderRoutes', () => {
    const mailbox = (id: string, recipientDomains?: string[]) => ({ id, userId: 'user-1', emailAddress: `${id}@test.com`, recipientDomains });

    it("gives each pool mailbox the campaign's Recipient Domains for it", () => {
      const campaign = {
        userId: 'user-1',
        senderAccount: mailbox('acc-1', []),
        senders: [
          { senderAccount: mailbox('acc-1', []), recipientDomains: [] },
          { senderAccount: mailbox('acc-2', []), recipientDomains: ['gmail.com'] },
        ],
      };
      const { pool } = resolveCampaignSenders(campaign);
      expect(resolveSenderRoutes(campaign, pool)).toEqual(new Map([['acc-1', []], ['acc-2', ['gmail.com']]]));
    });

    it("takes a mailbox's own Recipient Domains before the campaign's for it", () => {
      const campaign = {
        userId: 'user-1',
        senderAccount: mailbox('acc-1', []),
        senders: [
          { senderAccount: mailbox('acc-1', ['outlook.com']), recipientDomains: ['gmail.com'] },
          { senderAccount: mailbox('acc-2', ['yahoo.com']), recipientDomains: [] },
        ],
      };
      const { pool } = resolveCampaignSenders(campaign);
      expect(resolveSenderRoutes(campaign, pool)).toEqual(new Map([['acc-1', ['outlook.com']], ['acc-2', ['yahoo.com']]]));
    });

    it('gives the primary sender standing in for an empty pool its own list only', () => {
      const withList = { userId: 'user-1', senderAccount: mailbox('acc-1', ['gmail.com']), senders: [] };
      expect(resolveSenderRoutes(withList, resolveCampaignSenders(withList).pool)).toEqual(new Map([['acc-1', ['gmail.com']]]));
      // Rows loaded before the column existed have no list.
      const without = { userId: 'user-1', senderAccount: mailbox('acc-1'), senders: [] };
      expect(resolveSenderRoutes(without, resolveCampaignSenders(without).pool)).toEqual(new Map([['acc-1', []]]));
    });
  });

  describe('pickSender', () => {
    const senderA = {
      id: 'sender-a',
      emailAddress: 'a@test.com',
      warmupEnabled: false,
      warmupStartedAt: null,
      dailyLimit: 100,
      warmupLimit: 10,
      warmupRamp: 2
    };

    const senderB = {
      id: 'sender-b',
      emailAddress: 'b@test.com',
      warmupEnabled: true,
      warmupStartedAt: new Date('2026-06-15T12:00:00Z'),
      dailyLimit: 200,
      warmupLimit: 50,
      warmupRamp: 10
    };

    const pool = [senderA, senderB];
    const now = new Date('2026-06-17T12:00:00Z'); // 2 days active for senderB -> cap is 50 + 10 * 2 = 70

    it('should pick the sender with the maximum remaining daily capacity', () => {
      const sentToday = new Map<string, number>();
      sentToday.set('sender-a', 40); // 100 - 40 = 60 remaining
      sentToday.set('sender-b', 5);  // 70 - 5 = 65 remaining -> B has more remaining

      const picked = pickSender(pool, sentToday, now);
      expect(picked?.id).toBe('sender-b');
    });

    it('should pick the other sender if one has more remaining capacity', () => {
      const sentToday = new Map<string, number>();
      sentToday.set('sender-a', 20); // 100 - 20 = 80 remaining -> A has more remaining
      sentToday.set('sender-b', 5);  // 70 - 5 = 65 remaining

      const picked = pickSender(pool, sentToday, now);
      expect(picked?.id).toBe('sender-a');
    });

    it('should return null if all senders in the pool are at cap', () => {
      const sentToday = new Map<string, number>();
      sentToday.set('sender-a', 100); // 0 remaining
      sentToday.set('sender-b', 70);  // 0 remaining

      const picked = pickSender(pool, sentToday, now);
      expect(picked).toBeNull();
    });

    describe('with the mailboxes\' daily limits off', () => {
      it('picks the sender that sent least in the last 24 hours, whatever its daily limit', () => {
        // A is far past its daily limit of 100, which no longer applies.
        expect(pickSender(pool, new Map([['sender-a', 500], ['sender-b', 60]]), now, true)?.id).toBe('sender-b');
        expect(pickSender(pool, new Map([['sender-a', 30], ['sender-b', 60]]), now, true)?.id).toBe('sender-a');
      });

      it('takes the first of two that sent the same', () => {
        expect(pickSender(pool, new Map(), now, true)?.id).toBe('sender-a');
      });

      it('passes over a warming sender at its ramp cap, even though it sent least', () => {
        // B's ramp allows 70; A has no cap of its own.
        expect(pickSender(pool, new Map([['sender-a', 900], ['sender-b', 70]]), now, true)?.id).toBe('sender-a');
      });

      it('returns null only when every sender is warming up and at its ramp cap', () => {
        const warmingA = { ...senderB, id: 'sender-a' };
        expect(pickSender([warmingA, senderB], new Map([['sender-a', 70], ['sender-b', 70]]), now, true)).toBeNull();
        expect(pickSender([senderA], new Map([['sender-a', 1000000]]), now, true)?.id).toBe('sender-a');
      });
    });
  });

  describe('classifyFailure', () => {
    it('should classify quota errors based on keywords', () => {
      expect(classifyFailure(new Error('Quota limit exceeded'))).toBe('quota');
      expect(classifyFailure(new Error('Daily sending rate reached'))).toBe('quota');
      expect(classifyFailure(new Error('Email send quota exceeded for this resource.'))).toBe('quota');
      expect(classifyFailure(new Error('550 5.4.5 Daily user sending quota exceeded'))).toBe('quota');
      expect(classifyFailure(new Error('Rate limit exceeded, retry later'))).toBe('quota');
      expect(classifyFailure(new Error('Request was throttled'))).toBe('quota');
      expect(classifyFailure(new Error('Hourly limit reached'))).toBe('quota');
    });

    it('should classify an ACS 429 or quota error code as quota whatever the message says (M2)', () => {
      expect(classifyFailure(new EmailSendError('Slow down.', { statusCode: 429, code: 'TooManyRequests' }))).toBe('quota');
      expect(classifyFailure(new EmailSendError('Please try again later.', { statusCode: 429 }))).toBe('quota');
      expect(classifyFailure(new EmailSendError('Request refused.', { code: 'QuotaExceeded' }))).toBe('quota');
    });

    it('should match quota words whole, not inside other words or other limits (M2)', () => {
      expect(classifyFailure(new Error('Could not generate a separate, accurate preview'))).toBe('soft');
      expect(classifyFailure(new Error('Message size limit exceeded'))).toBe('soft');
      expect(classifyFailure(new Error('Recipient list exceeded the unlimited plan'))).toBe('soft');
      expect(classifyFailure({ message: '421 Space limit exceeded' })).toBe('soft');
      expect(classifyFailure(new Error(
        'Timed out fetching a new connection from the connection pool. (Current connection pool timeout: 10, connection limit: 5)'
      ))).toBe('soft');
    });

    it("should classify a recipient's full or over-quota mailbox as soft, not the campaign's quota (M2)", () => {
      expect(classifyFailure(new Error('Mailbox quota exceeded'))).toBe('soft');
      expect(classifyFailure(new Error('452 4.2.2 The email account that you tried to reach is over quota'))).toBe('soft');
      expect(classifyFailure(new Error("The recipient's inbox is full"))).toBe('soft');
      expect(classifyFailure({ message: '552 5.2.2 Storage exceeded', responseCode: 552 })).toBe('soft');
    });

    it('should classify Azure clock-skew rejections as systemic (campaign pause, not per-lead retries)', () => {
      expect(classifyFailure(new Error(
        'The given request could not be resolved.\nThe time difference between the originating client and the server is greater than the allowed margin of 5 minutes.'
      ))).toBe('systemic');
    });

    it('should classify config errors, a refused access key and an unlinked sender domain as systemic (H9)', () => {
      expect(classifyFailure(new EmailConfigError('Sender domain "gmail.com" is not in the verified Azure sender domains list.'))).toBe('systemic');
      expect(classifyFailure(new EmailSendError('Denied by the resource provider.', { statusCode: 401, code: 'Denied' }))).toBe('systemic');
      expect(classifyFailure(new EmailSendError('Forbidden.', { statusCode: 403 }))).toBe('systemic');
      expect(classifyFailure(new EmailSendError('The specified sender domain has not been linked.', { statusCode: 404, code: 'DomainNotLinked' }))).toBe('systemic');
    });

    it('should classify a connection string that cannot be decrypted as systemic (H9)', async () => {
      const err = await sendMessage(
        { to: 'lead@prospect.test', subject: 's', body: 'b', isHtml: false, sender: { emailAddress: 'one@acme.test' } },
        { activeProvider: 'AZURE', azureConnString: 'enc:v1:saved-under-another-key', azureSenderDomains: ['acme.test'] }
      ).catch((e) => e);

      expect(err).toBeInstanceOf(EmailConfigError);
      expect(classifyFailure(err)).toBe('systemic');
    });

    it('should classify a connection string the Azure SDK cannot parse as systemic, without echoing it (H9)', async () => {
      for (const azureConnString of ['accesskey-only-a2V5', 'endpoint=notaurl;accesskey=a2V5', 'endpoint=https://acs.test/path;accesskey=a2V5']) {
        const err = await sendMessage(
          { to: 'lead@prospect.test', subject: 's', body: 'b', isHtml: false, sender: { emailAddress: 'one@acme.test' } },
          { activeProvider: 'AZURE', azureConnString, azureSenderDomains: ['acme.test'] }
        ).catch((e) => e);

        expect(err).toBeInstanceOf(EmailConfigError);
        expect(err.message).toBe('The saved Azure Communication Services connection string is not valid; an admin must save it again in Settings.');
        expect(err.message).not.toContain('a2V5');
        expect(classifyFailure(err)).toBe('systemic');
      }
    });

    it('should classify response codes 500-559 (except 552) as hard failures', () => {
      expect(classifyFailure({ message: 'SMTP error', responseCode: 550 })).toBe('hard');
      expect(classifyFailure({ message: 'SMTP error', responseCode: 554 })).toBe('hard');
    });

    it('should classify sender-side/system issues as soft failures even if they have 5xx response code', () => {
      expect(classifyFailure({ message: '535 Authentication credentials invalid', responseCode: 535 })).toBe('soft');
      expect(classifyFailure({ message: 'Bad credentials', responseCode: 535 })).toBe('soft');
      expect(classifyFailure({ message: 'SMTP login failed', responseCode: 535 })).toBe('soft');
    });

    it('should classify specific invalid user/mailbox/domain patterns as hard failures', () => {
      expect(classifyFailure(new Error('no such user here'))).toBe('hard');
      expect(classifyFailure(new Error('User unknown'))).toBe('hard');
      expect(classifyFailure(new Error('Mailbox unavailable'))).toBe('hard');
      expect(classifyFailure(new Error('Recipient address rejected'))).toBe('hard');
      expect(classifyFailure(new Error('Domain not found NXDOMAIN'))).toBe('hard');
      expect(classifyFailure(new Error('5.1.1 Invalid email address'))).toBe('hard');
    });

    it('should classify ACS dropping a send for a suppressed recipient as hard, by its error code (stats A4)', () => {
      // What the provider throws now: ACS's own error code and message.
      expect(classifyFailure(new EmailSendError('Message dropped because all recipients were suppressed', { code: 'EmailDroppedAllRecipientsSuppressed' }))).toBe('hard');
      // The code decides whatever the message says, in any case.
      expect(classifyFailure(new EmailSendError('Azure Communication Services reported send status: Failed.', { code: 'EmailDroppedAllRecipientsSuppressed' }))).toBe('hard');
      expect(classifyFailure(new EmailSendError('Refused.', { code: 'EMAILDROPPEDALLRECIPIENTSSUPPRESSED' }))).toBe('hard');
    });

    it('should classify ACS dropping a send for a suppressed recipient as hard, by its wording without a code (stats A4)', () => {
      // The old engine's long-running-operation text, as stored in CampaignEnrollment.lastError.
      expect(classifyFailure(new Error(
        'The long-running operation has failed. EmailDroppedAllRecipientsSuppressed. Message dropped because all recipients were suppressed'
      ))).toBe('hard');
      expect(classifyFailure(new Error('Message dropped because all recipients were suppressed'))).toBe('hard');
      expect(classifyFailure({ message: 'MESSAGE DROPPED BECAUSE ALL RECIPIENTS WERE SUPPRESSED.' })).toBe('hard');
      expect(classifyFailure(new Error('Send refused: emaildroppedallrecipientssuppressed'))).toBe('hard');
    });

    it('should keep throttling, network errors and timeouts off the suppressed-recipient hard bounce (stats A4)', () => {
      expect(classifyFailure(new EmailSendError('Slow down.', { statusCode: 429, code: 'TooManyRequests' }))).toBe('quota');
      expect(classifyFailure(new EmailSendError('read ECONNRESET', { code: 'ECONNRESET' }))).toBe('soft');
      expect(classifyFailure(new EmailSendError('getaddrinfo ENOTFOUND acs.test', { code: 'ENOTFOUND' }))).toBe('soft');
      expect(classifyFailure(new EmailSendError('The operation was aborted due to timeout', { code: 'REQUEST_SEND_ERROR' }))).toBe('soft');
      expect(classifyFailure(new Error('Connection timed out ETIMEDOUT'))).toBe('soft');
      expect(classifyFailure(new EmailSendError('Service is down.', { statusCode: 503, code: 'ServiceUnavailable' }))).toBe('soft');
      // "suppressed" alone is not the refusal.
      expect(classifyFailure(new Error('Duplicate message suppressed'))).toBe('soft');
    });

    it('should classify response codes 400-499 as soft failures', () => {
      expect(classifyFailure({ message: 'SMTP error', responseCode: 421 })).toBe('soft');
      expect(classifyFailure({ message: 'SMTP error', responseCode: 451 })).toBe('soft');
    });

    it('should classify response code 552 as soft failure (mailbox full)', () => {
      expect(classifyFailure({ message: 'Mailbox full', responseCode: 552 })).toBe('soft');
    });

    it('should classify network/timeout patterns as soft failures', () => {
      expect(classifyFailure(new Error('Connection timed out ETIMEDOUT'))).toBe('soft');
      expect(classifyFailure(new Error('connect ECONNREFUSED 127.0.0.1:25'))).toBe('soft');
      expect(classifyFailure(new Error('greylisting active'))).toBe('soft');
      expect(classifyFailure(new Error('Try again later'))).toBe('soft');
    });

    it('should classify unrecognized/unknown errors as soft failures (fail-safe)', () => {
      expect(classifyFailure(new Error('Something went completely wrong'))).toBe('soft');
      expect(classifyFailure({ message: 'Internal server error 500' })).toBe('soft');
    });
  });
});
