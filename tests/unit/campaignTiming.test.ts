import { describe, it, expect } from 'vitest';
import {
  durationText, windowState, sendTime, scheduleSummary, zonedDateTime, zonedClock, zonedDate, utcOffsetMinutes, utcOffsetText,
  zoneShortName, zoneLabel, zoneDifferenceText, bothZones, earliestFinish,
} from '../../lib/campaignTiming';
import { checkSendingWindow, nextWindowClosing, nextWindowOpening } from '../../lib/sendSchedule';

const at = (iso: string) => new Date(iso);
const EVERY_DAY = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
const OFFICE_HOURS = { days: WEEKDAYS, window: { start: '09:00', end: '17:00' } };
const MONDAY_NIGHT = { days: ['Mon'], window: { start: '22:00', end: '06:00' } };
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// 2026-06-08 is a Monday.
describe('nextWindowClosing', () => {
  it('closes the minute after the end time, which is itself still open', () => {
    const closes = nextWindowClosing('UTC', OFFICE_HOURS, at('2026-06-08T10:43:20Z'));
    expect(closes).toEqual(at('2026-06-08T17:01:00Z'));
    expect(checkSendingWindow('UTC', OFFICE_HOURS, new Date(closes!.getTime() - 1))).toBe(true);
    expect(checkSendingWindow('UTC', OFFICE_HOURS, closes!)).toBe(false);
  });

  it('closes within the minute when asked during the last open minute', () => {
    expect(nextWindowClosing('UTC', OFFICE_HOURS, at('2026-06-08T17:00:30Z'))).toEqual(at('2026-06-08T17:01:00Z'));
  });

  it('is null while the window is closed', () => {
    expect(nextWindowClosing('UTC', OFFICE_HOURS, at('2026-06-08T08:59:59Z'))).toBeNull(); // before it opens
    expect(nextWindowClosing('UTC', OFFICE_HOURS, at('2026-06-08T17:01:00Z'))).toBeNull(); // just closed
    expect(nextWindowClosing('UTC', OFFICE_HOURS, at('2026-06-07T10:00:00Z'))).toBeNull(); // Sunday
  });

  it('is null without a complete schedule or a known timezone', () => {
    expect(nextWindowClosing('UTC', null, at('2026-06-08T10:00:00Z'))).toBeNull();
    expect(nextWindowClosing('UTC', { days: WEEKDAYS }, at('2026-06-08T10:00:00Z'))).toBeNull();
    expect(nextWindowClosing('Not/AZone', OFFICE_HOURS, at('2026-06-08T10:00:00Z'))).toBeNull();
    expect(nextWindowClosing('UTC', '{"days": ["Mon"', at('2026-06-08T10:00:00Z'))).toBeNull();
  });

  it('reads a schedule stored as JSON text', () => {
    expect(nextWindowClosing('UTC', JSON.stringify(OFFICE_HOURS), at('2026-06-08T10:00:00Z'))).toEqual(at('2026-06-08T17:01:00Z'));
  });

  it('closes a window that runs past midnight on the next morning', () => {
    expect(nextWindowClosing('UTC', MONDAY_NIGHT, at('2026-06-08T23:00:00Z'))).toEqual(at('2026-06-09T06:01:00Z')); // Mon 23:00
    expect(nextWindowClosing('UTC', MONDAY_NIGHT, at('2026-06-09T02:00:00Z'))).toEqual(at('2026-06-09T06:01:00Z')); // Tue 02:00
  });

  it('stays open through midnight while the next day continues an all-day window', () => {
    const allDay = { days: WEEKDAYS, window: { start: '00:00', end: '23:59' } };
    // Open from Monday 00:00 without a break until the end of Friday.
    expect(nextWindowClosing('UTC', allDay, at('2026-06-08T10:00:00Z'))).toEqual(at('2026-06-13T00:00:00Z'));
    expect(nextWindowClosing('UTC', allDay, at('2026-06-12T23:59:30Z'))).toEqual(at('2026-06-13T00:00:00Z'));
  });

  it('is null for a window that never closes', () => {
    expect(nextWindowClosing('UTC', { days: EVERY_DAY, window: { start: '00:00', end: '23:59' } }, at('2026-06-08T10:00:00Z'))).toBeNull();
    // 09:00 to 08:59 is the whole day too, each day handing over to the next.
    expect(nextWindowClosing('UTC', { days: EVERY_DAY, window: { start: '09:00', end: '08:59' } }, at('2026-06-08T10:00:00Z'))).toBeNull();
  });

  it("uses the campaign's timezone", () => {
    // 17:00 in New York in June is 21:00 UTC.
    expect(nextWindowClosing('America/New_York', OFFICE_HOURS, at('2026-06-08T15:00:00Z'))).toEqual(at('2026-06-08T21:01:00Z'));
    // 17:00 in Colombo is 11:30 UTC.
    expect(nextWindowClosing('Asia/Colombo', OFFICE_HOURS, at('2026-06-08T05:00:00Z'))).toEqual(at('2026-06-08T11:31:00Z'));
  });

  it('closes when a daylight-saving change skips past the end time', () => {
    // New York, Sunday 8 March 2026: 01:59 EST is followed by 03:00 EDT at 07:00 UTC.
    const sunday = { days: ['Sun'], window: { start: '01:00', end: '02:30' } };
    const closes = nextWindowClosing('America/New_York', sunday, at('2026-03-08T06:30:00Z')); // 01:30 EST
    expect(closes).toEqual(at('2026-03-08T07:00:00Z'));
    expect(checkSendingWindow('America/New_York', sunday, new Date(closes!.getTime() - 1))).toBe(true);
    expect(checkSendingWindow('America/New_York', sunday, closes!)).toBe(false);
  });

  it('closes at the first end of the window when the clock is set back over it', () => {
    // New York, Sunday 1 November 2026: 01:59 EDT is followed by 01:00 EST at 06:00 UTC.
    const sunday = { days: ['Sun'], window: { start: '00:00', end: '01:30' } };
    const closes = nextWindowClosing('America/New_York', sunday, at('2026-11-01T04:30:00Z')); // 00:30 EDT
    expect(closes).toEqual(at('2026-11-01T05:31:00Z')); // 01:31 EDT
    expect(checkSendingWindow('America/New_York', sunday, closes!)).toBe(false);
  });

  it('agrees with the opening: a window closed now opens, then closes at its end', () => {
    const opens = nextWindowOpening('America/New_York', OFFICE_HOURS, at('2026-06-06T12:00:00Z')); // Saturday
    expect(opens).toEqual(at('2026-06-08T13:00:00Z')); // Monday 09:00 EDT
    expect(nextWindowClosing('America/New_York', OFFICE_HOURS, opens!)).toEqual(at('2026-06-08T21:01:00Z'));
  });
});

describe('the send engine uses the same window checks', () => {
  it('re-exports them from lib/sendSchedule', async () => {
    const engine = await import('../../lib/sendEngine');
    expect(engine.checkSendingWindow).toBe(checkSendingWindow);
    expect(engine.nextWindowOpening).toBe(nextWindowOpening);
  });
});

describe('durationText', () => {
  it('shows seconds under a minute', () => {
    expect(durationText(1 * SECOND)).toBe('1s');
    expect(durationText(59 * SECOND + 999)).toBe('59s');
  });

  it('shows minutes and two-digit seconds under an hour', () => {
    expect(durationText(MINUTE)).toBe('1m 00s');
    expect(durationText(18 * MINUTE + 5 * SECOND)).toBe('18m 05s');
    expect(durationText(HOUR - SECOND)).toBe('59m 59s');
  });

  it('shows hours and minutes under a day, and days and hours beyond', () => {
    expect(durationText(HOUR)).toBe('1h');
    expect(durationText(6 * HOUR + 18 * MINUTE + 40 * SECOND)).toBe('6h 18m');
    expect(durationText(DAY)).toBe('1d');
    expect(durationText(2 * DAY + 4 * HOUR + 59 * MINUTE)).toBe('2d 4h');
    expect(durationText(23 * DAY)).toBe('23d');
  });

  it('shows nothing left as 0s', () => {
    expect(durationText(0)).toBe('0s');
    expect(durationText(999)).toBe('0s');
    expect(durationText(-5 * MINUTE)).toBe('0s');
    expect(durationText(NaN)).toBe('0s');
  });
});

describe('windowState', () => {
  it('is open with its closing time inside the window', () => {
    expect(windowState('UTC', OFFICE_HOURS, at('2026-06-08T10:00:00Z'))).toEqual({ state: 'open', closesAt: at('2026-06-08T17:01:00Z') });
  });

  it('is closed with its next opening outside the window', () => {
    expect(windowState('UTC', OFFICE_HOURS, at('2026-06-08T18:00:00Z'))).toEqual({ state: 'closed', opensAt: at('2026-06-09T09:00:00Z') });
    // Friday evening waits for Monday.
    expect(windowState('UTC', OFFICE_HOURS, at('2026-06-12T18:00:00Z'))).toEqual({ state: 'closed', opensAt: at('2026-06-15T09:00:00Z') });
  });

  it('is open with no closing time for a window that never closes', () => {
    expect(windowState('UTC', { days: EVERY_DAY, window: { start: '00:00', end: '23:59' } }, at('2026-06-08T10:00:00Z')))
      .toEqual({ state: 'open', closesAt: null });
  });

  it('is none without a complete schedule or a known timezone, as the send engine then sends nothing', () => {
    expect(windowState('UTC', null, at('2026-06-08T10:00:00Z'))).toEqual({ state: 'none' });
    expect(windowState('UTC', { days: [], window: { start: '09:00', end: '17:00' } }, at('2026-06-08T10:00:00Z'))).toEqual({ state: 'none' });
    expect(windowState('Not/AZone', OFFICE_HOURS, at('2026-06-08T10:00:00Z'))).toEqual({ state: 'none' });
    expect(windowState(null, OFFICE_HOURS, at('2026-06-08T10:00:00Z'))).toEqual({ state: 'none' });
  });

  it('reads a schedule stored as JSON text', () => {
    expect(windowState('UTC', JSON.stringify(OFFICE_HOURS), at('2026-06-08T10:00:00Z')).state).toBe('open');
  });
});

describe('sendTime', () => {
  it('is the due date itself when the window is open then', () => {
    const due = at('2026-06-08T10:00:00Z'); // Monday 10:00
    expect(sendTime('UTC', OFFICE_HOURS, due)).toEqual({ at: due, held: false });
    expect(sendTime('UTC', OFFICE_HOURS, at('2026-06-08T17:00:59Z'))).toEqual({ at: at('2026-06-08T17:00:59Z'), held: false });
  });

  it('waits for the next opening when the window is closed then', () => {
    // Saturday noon waits for Monday 09:00.
    expect(sendTime('UTC', OFFICE_HOURS, at('2026-06-13T12:00:00Z'))).toEqual({ at: at('2026-06-15T09:00:00Z'), held: true });
    // Monday 18:00 waits for Tuesday 09:00.
    expect(sendTime('UTC', OFFICE_HOURS, at('2026-06-08T18:00:00Z'))).toEqual({ at: at('2026-06-09T09:00:00Z'), held: true });
  });

  it("reads the window in the campaign's timezone", () => {
    // 16:00 UTC on Saturday is 01:00 on Sunday in Tokyo, which waits for Monday 09:00 there.
    expect(sendTime('Asia/Tokyo', OFFICE_HOURS, at('2026-10-10T16:00:00Z'))).toEqual({ at: at('2026-10-12T00:00:00Z'), held: true });
  });

  it('leaves the due date as it is without a complete schedule or a known timezone', () => {
    const due = at('2026-06-13T12:00:00Z');
    expect(sendTime('UTC', null, due)).toEqual({ at: due, held: false });
    expect(sendTime('Not/AZone', OFFICE_HOURS, due)).toEqual({ at: due, held: false });
  });
});

describe('scheduleSummary', () => {
  it('names a run of days by its ends, and every day as such', () => {
    expect(scheduleSummary(OFFICE_HOURS)).toBe('Mon to Fri, 09:00 to 17:00');
    expect(scheduleSummary({ days: EVERY_DAY, window: { start: '00:00', end: '23:59' } })).toBe('Every day, 00:00 to 23:59');
    expect(scheduleSummary({ days: ['Tue', 'Wed', 'Thu'], window: { start: '08:30', end: '12:00' } })).toBe('Tue to Thu, 08:30 to 12:00');
  });

  it('lists days that are not one run, in week order whatever order they were saved in', () => {
    expect(scheduleSummary({ days: ['Fri', 'Mon', 'Wed'], window: { start: '09:00', end: '17:00' } })).toBe('Mon, Wed, Fri, 09:00 to 17:00');
    expect(scheduleSummary({ days: ['Sat', 'Sun'], window: { start: '10:00', end: '14:00' } })).toBe('Sat, Sun, 10:00 to 14:00');
    expect(scheduleSummary({ days: ['Mon'], window: { start: '09:00', end: '17:00' } })).toBe('Mon, 09:00 to 17:00');
  });

  it('says when the window runs into the next day', () => {
    expect(scheduleSummary(MONDAY_NIGHT)).toBe('Mon, 22:00 to 06:00 the next day');
  });

  it('reads JSON text, and is null for anything that is not a complete schedule', () => {
    expect(scheduleSummary(JSON.stringify(OFFICE_HOURS))).toBe('Mon to Fri, 09:00 to 17:00');
    expect(scheduleSummary(null)).toBeNull();
    expect(scheduleSummary('{"days": ["Mon"')).toBeNull();
    expect(scheduleSummary({ days: WEEKDAYS })).toBeNull();
  });
});

describe('times in a zone', () => {
  const instant = at('2026-10-08T13:00:07Z'); // Thursday

  it('shows the date and 24-hour time in the zone asked for, with its name', () => {
    const newYork = zonedDateTime(instant, 'America/New_York', { locale: 'en-US' });
    expect(newYork).toContain('Thu');
    expect(newYork).toContain('09:00');
    expect(newYork).toContain('EDT');
    const colombo = zonedDateTime(instant, 'Asia/Colombo', { locale: 'en-US' });
    expect(colombo).toContain('18:30');
    expect(colombo).toContain('UTC+5:30');
  });

  it('names the zone the same way whatever the locale, which only orders the date', () => {
    // British English alone would write New York as GMT-4.
    const british = zonedDateTime(instant, 'America/New_York', { locale: 'en-GB' });
    expect(british).toBe('Thu 8 Oct, 09:00 EDT');
    expect(zonedDateTime(instant, 'America/New_York', { locale: 'en-US' })).toBe('Thu, Oct 8, 09:00 EDT');
  });

  it('leaves the zone name out when asked to', () => {
    const colombo = zonedDateTime(instant, 'Asia/Colombo', { zoneName: false, locale: 'en-GB' });
    expect(colombo).toBe('Thu 8 Oct, 18:30');
  });

  it("gives a zone's short name, or its offset where it has none", () => {
    expect(zoneShortName(instant, 'America/New_York')).toBe('EDT');
    expect(zoneShortName(at('2026-01-15T12:00:00Z'), 'America/New_York')).toBe('EST');
    expect(zoneShortName(instant, 'America/Los_Angeles')).toBe('PDT');
    expect(zoneShortName(instant, 'Asia/Colombo')).toBe('UTC+5:30');
    expect(zoneShortName(instant, 'UTC')).toBe('UTC');
  });

  it('shows the date on the far side of midnight', () => {
    // 20:00 UTC on Thursday is 01:30 on Friday in Colombo.
    expect(zonedDate(at('2026-10-08T20:00:00Z'), 'Asia/Colombo', 'en-US')).toContain('Fri');
    expect(zonedDate(at('2026-10-08T20:00:00Z'), 'America/New_York', 'en-US')).toContain('Thu');
  });

  it('shows a 24-hour clock with seconds', () => {
    expect(zonedClock(instant, 'America/New_York', 'en-US')).toBe('09:00:07');
    expect(zonedClock(instant, 'Asia/Colombo', 'en-US')).toBe('18:30:07');
    expect(zonedClock(at('2026-10-08T04:00:00Z'), 'America/New_York', 'en-US')).toBe('00:00:00'); // midnight, never 24:00
    expect(zonedClock(at('2026-10-08T21:05:09Z'), 'UTC', 'en-US')).toBe('21:05:09');
  });

  it("reads a zone's offset, which follows daylight saving", () => {
    expect(utcOffsetMinutes(instant, 'America/New_York')).toBe(-240);
    expect(utcOffsetMinutes(at('2026-01-15T12:00:00Z'), 'America/New_York')).toBe(-300);
    expect(utcOffsetMinutes(instant, 'Asia/Colombo')).toBe(330);
    expect(utcOffsetMinutes(instant, 'UTC')).toBe(0);
    expect(utcOffsetText(instant, 'America/New_York')).toBe('UTC-04:00');
    expect(utcOffsetText(instant, 'Asia/Colombo')).toBe('UTC+05:30');
    expect(utcOffsetText(instant, 'UTC')).toBe('UTC+00:00');
  });

  it('labels a zone by its name and offset, or the offset alone when it has no name', () => {
    expect(zoneLabel(instant, 'America/New_York')).toBe('EDT (UTC-04:00)');
    expect(zoneLabel(at('2026-01-15T12:00:00Z'), 'America/New_York')).toBe('EST (UTC-05:00)');
    expect(zoneLabel(instant, 'Asia/Colombo')).toBe('UTC+05:30');
    expect(zoneLabel(instant, 'UTC')).toBe('UTC+00:00');
  });

  it('says how far one zone is from another', () => {
    expect(zoneDifferenceText(instant, 'Asia/Colombo', 'America/New_York')).toBe('9h 30m ahead');
    expect(zoneDifferenceText(instant, 'America/New_York', 'Asia/Colombo')).toBe('9h 30m behind');
    expect(zoneDifferenceText(instant, 'America/Los_Angeles', 'America/New_York')).toBe('3h behind');
    expect(zoneDifferenceText(instant, 'America/New_York', 'America/Toronto')).toBeNull();
    // In winter New York is 10h 30m behind Colombo, which has no daylight saving.
    expect(zoneDifferenceText(at('2026-01-15T12:00:00Z'), 'Asia/Colombo', 'America/New_York')).toBe('10h 30m ahead');
  });

  it('falls back to the runtime zone for an unknown zone instead of throwing', () => {
    expect(() => zonedDateTime(instant, 'Not/AZone')).not.toThrow();
    expect(() => zonedClock(instant, null)).not.toThrow();
    expect(() => utcOffsetMinutes(instant, undefined)).not.toThrow();
  });
});

describe('bothZones', () => {
  const instant = at('2026-10-08T13:00:00Z');

  it("gives the campaign's time with its zone name and the viewer's without", () => {
    const both = bothZones(instant, 'America/New_York', 'Asia/Colombo', 'en-US');
    expect(both.campaign).toContain('09:00');
    expect(both.campaign).toContain('EDT');
    expect(both.viewer).toContain('18:30');
    expect(both.viewer).not.toContain('UTC');
  });

  it('gives one time when both zones read the same then', () => {
    expect(bothZones(instant, 'America/New_York', 'America/New_York', 'en-US').viewer).toBeNull();
    expect(bothZones(instant, 'America/New_York', 'America/Toronto', 'en-US').viewer).toBeNull();
    // London matches UTC in winter only.
    expect(bothZones(at('2026-01-15T12:00:00Z'), 'UTC', 'Europe/London', 'en-US').viewer).toBeNull();
    expect(bothZones(at('2026-07-15T12:00:00Z'), 'UTC', 'Europe/London', 'en-US').viewer).toContain('13:00');
  });
});

describe('earliestFinish', () => {
  const now = at('2026-10-08T12:00:00Z');
  const steps = [
    { stepOrder: 1, waitDays: 0 },
    { stepOrder: 2, waitDays: 4 },
    { stepOrder: 3, waitDays: 3 },
  ];

  it('adds the wait days of the steps still to come to the latest send date', () => {
    // Waiting for step 1, due in 2 hours: step 2 comes 4 days later and step 3 another 3.
    const waiting = [{ stepOrder: 1, active: 10, lastDueAt: new Date(now.getTime() + 2 * HOUR) }];
    expect(earliestFinish(steps, waiting, now)).toEqual(new Date(now.getTime() + 2 * HOUR + 7 * DAY));
  });

  it('starts from now for leads whose send date has passed or is missing', () => {
    expect(earliestFinish(steps, [{ stepOrder: 2, active: 3, lastDueAt: new Date(now.getTime() - 5 * HOUR) }], now))
      .toEqual(new Date(now.getTime() + 3 * DAY));
    expect(earliestFinish(steps, [{ stepOrder: 2, active: 3, lastDueAt: null }], now)).toEqual(new Date(now.getTime() + 3 * DAY));
    expect(earliestFinish(steps, [{ stepOrder: 2, active: 3 }], now)).toEqual(new Date(now.getTime() + 3 * DAY));
  });

  it('is the send date itself for leads on the last step', () => {
    const due = new Date(now.getTime() + 6 * HOUR);
    expect(earliestFinish(steps, [{ stepOrder: 3, active: 1, lastDueAt: due }], now)).toEqual(due);
    expect(earliestFinish(steps, [{ stepOrder: 3, active: 1, lastDueAt: new Date(now.getTime() - HOUR) }], now)).toEqual(now);
  });

  it('takes the latest of the steps leads are waiting on', () => {
    const waiting = [
      { stepOrder: 1, active: 5, lastDueAt: new Date(now.getTime() - HOUR) }, // now + 7 days
      { stepOrder: 2, active: 5, lastDueAt: new Date(now.getTime() + 5 * DAY) }, // + 3 days = now + 8 days
      { stepOrder: 3, active: 5, lastDueAt: new Date(now.getTime() + 2 * DAY) }, // now + 2 days
    ];
    expect(earliestFinish(steps, waiting, now)).toEqual(new Date(now.getTime() + 8 * DAY));
  });

  it('reads send dates given as ISO text, as the API sends them', () => {
    const due = new Date(now.getTime() + 2 * HOUR);
    expect(earliestFinish(steps, [{ stepOrder: 3, active: 1, lastDueAt: due.toISOString() }], now)).toEqual(due);
  });

  it('leaves out steps nobody waits on and steps the campaign no longer has', () => {
    const waiting = [
      { stepOrder: 1, active: 0, lastDueAt: new Date(now.getTime() + 30 * DAY) },
      { stepOrder: 9, active: 4, lastDueAt: new Date(now.getTime() + 30 * DAY) },
      { stepOrder: 3, active: 2, lastDueAt: new Date(now.getTime() + DAY) },
    ];
    expect(earliestFinish(steps, waiting, now)).toEqual(new Date(now.getTime() + DAY));
  });

  it('is null when no lead is waiting', () => {
    expect(earliestFinish(steps, [], now)).toBeNull();
    expect(earliestFinish(steps, [{ stepOrder: 1, active: 0, lastDueAt: null }], now)).toBeNull();
    expect(earliestFinish([], [{ stepOrder: 1, active: 3, lastDueAt: null }], now)).toBeNull();
  });
});
