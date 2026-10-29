import { describe, it, expect } from 'vitest';
import { labelWeekday, sendsByWeekday } from '@/lib/busiestSendDay';

const today = new Date(2026, 9, 25, 12); // Sun 25 Oct 2026

describe('labelWeekday', () => {
  it('reads a trend label as a weekday, Monday first', () => {
    expect(labelWeekday('Oct 19', today)).toBe(0); // Monday
    expect(labelWeekday('Oct 25', today)).toBe(6); // Sunday
  });

  it('puts a label that would be in the future into last year', () => {
    // 28 Dec 2025 was a Sunday; 28 Dec 2026 is a Monday.
    expect(labelWeekday('Dec 28', new Date(2026, 0, 3))).toBe(6);
  });

  it('keeps a label a day ahead of the viewer in this year', () => {
    // A server ahead of the viewer's zone can already be on tomorrow: Mon 26 Oct 2026.
    expect(labelWeekday('Oct 26', today)).toBe(0);
  });

  it('returns null for labels it cannot read', () => {
    expect(labelWeekday('Mon', today)).toBeNull();
    expect(labelWeekday('Foo 12', today)).toBeNull();
    expect(labelWeekday('Oct 0', today)).toBeNull();
  });
});

describe('sendsByWeekday', () => {
  it('adds each day into its weekday and names the busiest', () => {
    const trends = [
      { name: 'Oct 12', sent: 10 }, // Mon
      { name: 'Oct 15', sent: 30 }, // Thu
      { name: 'Oct 19', sent: 25 }, // Mon
      { name: 'Oct 22', sent: 20 }, // Thu
    ];
    const { days, busiest } = sendsByWeekday(trends, today);
    expect(days.map((d) => d.sent)).toEqual([35, 0, 0, 50, 0, 0, 0]);
    expect(busiest).toEqual({ day: 'Thu', sent: 50 });
  });

  it('takes the earliest weekday on a tie', () => {
    const { busiest } = sendsByWeekday([{ name: 'Oct 21', sent: 5 }, { name: 'Oct 20', sent: 5 }], today);
    expect(busiest?.day).toBe('Tue');
  });

  it('has no busiest day when nothing was sent', () => {
    expect(sendsByWeekday([], today).busiest).toBeNull();
    expect(sendsByWeekday([{ name: 'Oct 20', sent: 0 }], today).busiest).toBeNull();
  });
});
