import { describe, it, expect } from 'vitest';
import { isLikelyScannerUA, isWithinPrefetchWindow, shouldDropEvent } from '../../lib/botFilter';

describe('isLikelyScannerUA', () => {
  it('should return true for known email-security scanners UAs', () => {
    expect(isLikelyScannerUA('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Barracuda Sentinel/1.0')).toBe(true);
    expect(isLikelyScannerUA('Mimecast Scanner UA')).toBe(true);
    expect(isLikelyScannerUA('Proofpoint Protection Server')).toBe(true);
    expect(isLikelyScannerUA('Mozilla/5.0 (Windows NT; Microsoft ATP; Microsoft SafeLinks)')).toBe(true);
    expect(isLikelyScannerUA('Mozilla/5.0 ms-office-protocol-discovery')).toBe(true);
  });

  it('should return false for regular browsers, mail clients and proxy servers UAs', () => {
    expect(isLikelyScannerUA('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')).toBe(false);
    expect(isLikelyScannerUA('GoogleImageProxy')).toBe(false);
    expect(isLikelyScannerUA('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) AppleMail/605.1.15')).toBe(false);
    expect(isLikelyScannerUA(null)).toBe(false);
    expect(isLikelyScannerUA('')).toBe(false);
  });
});

describe('isWithinPrefetchWindow', () => {
  const now = new Date('2026-06-19T10:00:00Z');

  it('should return true for opens within 10 seconds', () => {
    const sentAt = new Date('2026-06-19T09:59:55Z'); // 5 seconds ago
    expect(isWithinPrefetchWindow(sentAt, 'open', now)).toBe(true);
  });

  it('should return false for opens after 10 seconds', () => {
    const sentAt = new Date('2026-06-19T09:59:45Z'); // 15 seconds ago
    expect(isWithinPrefetchWindow(sentAt, 'open', now)).toBe(false);
  });

  it('should return true for clicks within 5 seconds', () => {
    const sentAt = new Date('2026-06-19T09:59:58Z'); // 2 seconds ago
    expect(isWithinPrefetchWindow(sentAt, 'click', now)).toBe(true);
  });

  it('should return false for clicks after 5 seconds', () => {
    const sentAt = new Date('2026-06-19T09:59:53Z'); // 7 seconds ago
    expect(isWithinPrefetchWindow(sentAt, 'click', now)).toBe(false);
  });

  it('should return false if sentAt is in the future (fail-safe)', () => {
    const sentAt = new Date('2026-06-19T10:05:00Z'); // 5 minutes in the future
    expect(isWithinPrefetchWindow(sentAt, 'open', now)).toBe(false);
  });
});

describe('shouldDropEvent', () => {
  it('should drop scanner user-agents immediately', () => {
    const sentAt = new Date(Date.now() - 60000); // 1 minute ago
    const res = shouldDropEvent(sentAt, 'Barracuda Sentinel', 'open');
    expect(res.drop).toBe(true);
    expect(res.reason).toBe('scanner-ua');
  });

  it('should drop regular browser UAs if request arrives within the prefetch window', () => {
    const sentAt = new Date(Date.now() - 2000); // 2 seconds ago
    const res = shouldDropEvent(sentAt, 'Mozilla/5.0', 'open');
    expect(res.drop).toBe(true);
    expect(res.reason).toBe('prefetch-window');
  });

  it('should NOT drop normal user-agents requesting after the prefetch window', () => {
    const sentAt = new Date(Date.now() - 60000); // 1 minute ago
    const res = shouldDropEvent(sentAt, 'Mozilla/5.0', 'open');
    expect(res.drop).toBe(false);
  });
});
