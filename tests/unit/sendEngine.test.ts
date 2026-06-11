import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { validateSendingFrequency, checkSendingWindow, personalizeEmail } from '../../lib/sendEngine';

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
});
