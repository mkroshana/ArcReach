import { describe, it, expect } from 'vitest';
import { validateSendingFrequency } from '../../lib/sendEngine';

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
});
