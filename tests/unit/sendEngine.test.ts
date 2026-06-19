import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { validateSendingFrequency, checkSendingWindow, personalizeEmail, getEffectiveDailyCap, resolveCampaignSenders, pickSender, classifyFailure } from '../../lib/sendEngine';

describe('validateSendingFrequency', () => {
  it('should allow sending when all limits are within boundaries', () => {
    const sender = {
      minuteLimit: 5,
      hourlyLimit: 50,
      dailyLimit: 200,
      emailsSentLastMinute: 2,
      emailsSentLastHour: 20,
      emailsSentToday: 100,
    };
    
    const result = validateSendingFrequency(sender);
    expect(result.allowed).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('should restrict sending when minute limits are exceeded', () => {
    const sender = {
      minuteLimit: 5,
      hourlyLimit: 50,
      dailyLimit: 200,
      emailsSentLastMinute: 5,
      emailsSentLastHour: 20,
      emailsSentToday: 100,
    };
    
    const result = validateSendingFrequency(sender);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Max 5 per minute');
  });

  it('should restrict sending when hourly limits are exceeded', () => {
    const sender = {
      minuteLimit: 5,
      hourlyLimit: 50,
      dailyLimit: 200,
      emailsSentLastMinute: 2,
      emailsSentLastHour: 50,
      emailsSentToday: 100,
    };
    
    const result = validateSendingFrequency(sender);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Max 50 per hour');
  });

  it('should restrict sending when daily limits are exceeded', () => {
    const sender = {
      minuteLimit: 5,
      hourlyLimit: 50,
      dailyLimit: 200,
      emailsSentLastMinute: 2,
      emailsSentLastHour: 20,
      emailsSentToday: 200,
    };
    
    const result = validateSendingFrequency(sender);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Max 200 per day');
  });

  describe('checkSendingWindow', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should return true if no schedule is specified', () => {
      expect(checkSendingWindow('UTC', null)).toBe(true);
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

  describe('resolveCampaignSenders', () => {
    it('should return primary sender when pool is empty', () => {
      const campaign = {
        senderAccountId: 'acc-1',
        senderAccount: { id: 'acc-1', emailAddress: 'acc1@test.com' },
        senders: []
      };
      const result = resolveCampaignSenders(campaign);
      expect(result).toEqual([{ id: 'acc-1', emailAddress: 'acc1@test.com' }]);
    });

    it('should return pool senders when pool is populated', () => {
      const campaign = {
        senderAccountId: 'acc-1',
        senderAccount: { id: 'acc-1', emailAddress: 'acc1@test.com' },
        senders: [
          { senderAccount: { id: 'acc-2', emailAddress: 'acc2@test.com' } },
          { senderAccount: { id: 'acc-3', emailAddress: 'acc3@test.com' } }
        ]
      };
      const result = resolveCampaignSenders(campaign);
      expect(result).toEqual([
        { id: 'acc-2', emailAddress: 'acc2@test.com' },
        { id: 'acc-3', emailAddress: 'acc3@test.com' }
      ]);
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
  });

  describe('classifyFailure', () => {
    it('should classify quota errors based on keywords', () => {
      expect(classifyFailure(new Error('Quota limit exceeded'))).toBe('quota');
      expect(classifyFailure(new Error('Daily sending rate reached'))).toBe('quota');
      expect(classifyFailure({ message: '421 Space limit exceeded' })).toBe('quota');
    });

    it('should classify response codes 500-559 (except 552) as hard failures', () => {
      expect(classifyFailure({ message: 'SMTP error', responseCode: 550 })).toBe('hard');
      expect(classifyFailure({ message: 'SMTP error', responseCode: 554 })).toBe('hard');
      expect(classifyFailure({ message: 'SMTP error', responseCode: 552 })).not.toBe('hard');
    });

    it('should classify specific invalid user/mailbox/domain patterns as hard failures', () => {
      expect(classifyFailure(new Error('no such user here'))).toBe('hard');
      expect(classifyFailure(new Error('User unknown'))).toBe('hard');
      expect(classifyFailure(new Error('Mailbox unavailable'))).toBe('hard');
      expect(classifyFailure(new Error('Recipient address rejected'))).toBe('hard');
      expect(classifyFailure(new Error('Domain not found NXDOMAIN'))).toBe('hard');
      expect(classifyFailure(new Error('5.1.1 Invalid email address'))).toBe('hard');
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
