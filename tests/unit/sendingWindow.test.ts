import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const fake = vi.hoisted(() => ({
  campaign: { findUnique: vi.fn(), update: vi.fn() },
  campaignEnrollment: { count: vi.fn() },
  $transaction: vi.fn(),
}));

vi.mock('../../lib/db', () => ({
  prisma: fake,
}));

vi.mock('../../lib/session', () => ({
  getSession: vi.fn(),
}));

import { getSession } from '../../lib/session';
import { checkSendingWindow, nextWindowOpening } from '../../lib/sendEngine';
import { parseSendSchedule, sendScheduleError, timezoneError } from '../../lib/sendSchedule';
import { PUT as putCampaign } from '../../app/api/campaigns/[id]/route';

const mockedSession = vi.mocked(getSession);

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
const EVERY_DAY = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const OFFICE_HOURS = { days: WEEKDAYS, window: { start: '09:00', end: '17:00' } };
/** Opens on Monday at 22:00 and runs until Tuesday 06:00. */
const MONDAY_NIGHT = { days: ['Mon'], window: { start: '22:00', end: '06:00' } };

const at = (iso: string) => new Date(iso);

describe('checkSendingWindow fails closed (M4)', () => {
  it('lets a campaign with no saved schedule send at any time', () => {
    expect(checkSendingWindow('UTC', null, at('2026-06-07T03:00:00Z'))).toBe(true);
    expect(checkSendingWindow('UTC', undefined, at('2026-06-07T03:00:00Z'))).toBe(true);
  });

  it('keeps the window closed when no day is chosen', () => {
    // Monday 10:00 UTC: inside the times, but no day is permitted.
    expect(checkSendingWindow('UTC', { days: [], window: { start: '09:00', end: '17:00' } }, at('2026-06-08T10:00:00Z'))).toBe(false);
    expect(checkSendingWindow('UTC', { window: { start: '09:00', end: '17:00' } }, at('2026-06-08T10:00:00Z'))).toBe(false);
  });

  it.each([
    ['a cleared start time', { start: '', end: '17:00' }],
    ['a cleared end time', { start: '09:00', end: '' }],
    ['a missing end time', { start: '09:00' }],
    ['an unpadded hour', { start: '9:00', end: '17:00' }],
    ['hour 24', { start: '09:00', end: '24:00' }],
    ['minute 60', { start: '09:60', end: '17:00' }],
    ['seconds', { start: '09:00:00', end: '17:00' }],
  ])('keeps the window closed for %s, even at 03:00', (_label, window) => {
    const schedule = { days: EVERY_DAY, window };
    expect(checkSendingWindow('UTC', schedule, at('2026-06-08T03:00:00Z'))).toBe(false);
    expect(checkSendingWindow('UTC', schedule, at('2026-06-08T10:00:00Z'))).toBe(false);
  });

  it('keeps the window closed for a schedule with no window or an unknown day', () => {
    expect(checkSendingWindow('UTC', { days: EVERY_DAY }, at('2026-06-08T10:00:00Z'))).toBe(false);
    expect(checkSendingWindow('UTC', { days: ['Monday'], window: { start: '09:00', end: '17:00' } }, at('2026-06-08T10:00:00Z'))).toBe(false);
  });

  it.each(['America/NewYork', 'Mars/Olympus', ''])('keeps the window closed for the unknown timezone %j', (timezone) => {
    expect(checkSendingWindow(timezone, { days: EVERY_DAY, window: { start: '00:00', end: '23:59' } }, at('2026-06-08T10:00:00Z'))).toBe(false);
  });

  it('keeps the window closed when stored JSON text cannot be parsed, and reads it when it can', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(checkSendingWindow('UTC', '{"days": ["Mon"', at('2026-06-08T10:00:00Z'))).toBe(false);
    errorSpy.mockRestore();
    expect(checkSendingWindow('UTC', JSON.stringify(OFFICE_HOURS), at('2026-06-08T10:00:00Z'))).toBe(true);
  });

  it('includes both bounds to the minute', () => {
    expect(checkSendingWindow('UTC', OFFICE_HOURS, at('2026-06-08T08:59:59Z'))).toBe(false);
    expect(checkSendingWindow('UTC', OFFICE_HOURS, at('2026-06-08T09:00:00Z'))).toBe(true);
    expect(checkSendingWindow('UTC', OFFICE_HOURS, at('2026-06-08T17:00:59Z'))).toBe(true);
    expect(checkSendingWindow('UTC', OFFICE_HOURS, at('2026-06-08T17:01:00Z'))).toBe(false);
  });

  it('runs a window whose start is later than its end past midnight, on the day it opened', () => {
    expect(checkSendingWindow('UTC', MONDAY_NIGHT, at('2026-06-08T21:59:00Z'))).toBe(false); // Mon 21:59
    expect(checkSendingWindow('UTC', MONDAY_NIGHT, at('2026-06-08T22:00:00Z'))).toBe(true); // Mon 22:00
    expect(checkSendingWindow('UTC', MONDAY_NIGHT, at('2026-06-08T23:59:00Z'))).toBe(true); // Mon 23:59
    expect(checkSendingWindow('UTC', MONDAY_NIGHT, at('2026-06-09T02:00:00Z'))).toBe(true); // Tue 02:00
    expect(checkSendingWindow('UTC', MONDAY_NIGHT, at('2026-06-09T06:00:00Z'))).toBe(true); // Tue 06:00
    expect(checkSendingWindow('UTC', MONDAY_NIGHT, at('2026-06-09T06:01:00Z'))).toBe(false); // Tue 06:01
    expect(checkSendingWindow('UTC', MONDAY_NIGHT, at('2026-06-09T22:30:00Z'))).toBe(false); // Tue 22:30
    expect(checkSendingWindow('UTC', MONDAY_NIGHT, at('2026-06-08T02:00:00Z'))).toBe(false); // Mon 02:00, Sunday's night
  });

  it('follows the campaign timezone across daylight-saving changes', () => {
    // 13:30 UTC is 08:30 EST on Friday 6 March and 09:30 EDT on Monday 9 March 2026.
    expect(checkSendingWindow('America/New_York', OFFICE_HOURS, at('2026-03-06T13:30:00Z'))).toBe(false);
    expect(checkSendingWindow('America/New_York', OFFICE_HOURS, at('2026-03-09T13:30:00Z'))).toBe(true);
    // Back on EST from 1 November: 13:30 UTC is 08:30 and 14:00 UTC is 09:00 on Monday 2 November.
    expect(checkSendingWindow('America/New_York', OFFICE_HOURS, at('2026-11-02T13:30:00Z'))).toBe(false);
    expect(checkSendingWindow('America/New_York', OFFICE_HOURS, at('2026-11-02T14:00:00Z'))).toBe(true);
    // Sunday in New York while it is already Monday in UTC.
    expect(checkSendingWindow('America/New_York', { days: ['Sun'], window: { start: '20:00', end: '23:00' } }, at('2026-06-08T01:00:00Z'))).toBe(true);
  });
});

describe('nextWindowOpening (M4)', () => {
  it('returns `from` when the window is already open or there is no schedule', () => {
    const from = at('2026-06-08T10:15:30Z');
    expect(nextWindowOpening('UTC', OFFICE_HOURS, from)).toEqual(from);
    expect(nextWindowOpening('UTC', null, from)).toEqual(from);
  });

  it('returns the start time later the same day', () => {
    expect(nextWindowOpening('UTC', OFFICE_HOURS, at('2026-06-08T07:15:30Z'))).toEqual(at('2026-06-08T09:00:00Z'));
  });

  it('skips days the schedule does not permit', () => {
    // Friday evening to Monday morning.
    expect(nextWindowOpening('UTC', OFFICE_HOURS, at('2026-06-12T18:00:00Z'))).toEqual(at('2026-06-15T09:00:00Z'));
    // A window that only opens on Friday nights, a week of days later.
    const fridayNight = { days: ['Fri'], window: { start: '22:00', end: '06:00' } };
    expect(nextWindowOpening('UTC', fridayNight, at('2026-06-13T06:01:00Z'))).toEqual(at('2026-06-19T22:00:00Z'));
  });

  it('returns the local start time across daylight-saving changes', () => {
    // Friday 18:00 EST to Monday 09:00 EDT (clocks went forward on Sunday 8 March).
    expect(nextWindowOpening('America/New_York', OFFICE_HOURS, at('2026-03-06T23:00:00Z'))).toEqual(at('2026-03-09T13:00:00Z'));
    // Friday 18:00 EDT to Monday 09:00 EST (clocks went back on Sunday 1 November).
    expect(nextWindowOpening('America/New_York', OFFICE_HOURS, at('2026-10-30T22:00:00Z'))).toEqual(at('2026-11-02T14:00:00Z'));
  });

  it('opens at the clock change when the start time is skipped by daylight saving', () => {
    // On 8 March 2026 New York clocks jump from 01:59 EST to 03:00 EDT, so 02:30 never happens.
    const schedule = { days: EVERY_DAY, window: { start: '02:30', end: '04:00' } };
    const opening = nextWindowOpening('America/New_York', schedule, at('2026-03-08T06:30:00Z')); // 01:30 EST
    expect(opening).toEqual(at('2026-03-08T07:00:00Z')); // 03:00 EDT
    expect(checkSendingWindow('America/New_York', schedule, at('2026-03-08T06:59:00Z'))).toBe(false);
    expect(checkSendingWindow('America/New_York', schedule, opening!)).toBe(true);
  });

  it('opens again in the hour daylight saving repeats', () => {
    // On 1 November 2026 New York clocks run 01:00-01:59 twice, EDT then EST.
    const schedule = { days: EVERY_DAY, window: { start: '01:30', end: '01:40' } };
    expect(nextWindowOpening('America/New_York', schedule, at('2026-11-01T05:45:00Z'))) // 01:45 EDT
      .toEqual(at('2026-11-01T06:30:00Z')); // 01:30 EST
  });

  it('returns null when the window can never open', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const from = at('2026-06-08T10:00:00Z');
    expect(nextWindowOpening('America/NewYork', OFFICE_HOURS, from)).toBeNull();
    expect(nextWindowOpening('UTC', { days: [], window: { start: '09:00', end: '17:00' } }, from)).toBeNull();
    expect(nextWindowOpening('UTC', { days: WEEKDAYS, window: { start: '', end: '17:00' } }, from)).toBeNull();
    expect(nextWindowOpening('UTC', 'not json', from)).toBeNull();
    errorSpy.mockRestore();
  });
});

describe('sending schedule validation (M4)', () => {
  it('accepts a complete window, including one that runs past midnight', () => {
    expect(sendScheduleError(OFFICE_HOURS)).toBeNull();
    expect(sendScheduleError(MONDAY_NIGHT)).toBeNull();
  });

  it('names what is missing', () => {
    expect(sendScheduleError(null)).toBe('The sending schedule needs sending days and a start and end time.');
    expect(sendScheduleError([])).toBe('The sending schedule needs sending days and a start and end time.');
    expect(sendScheduleError({ days: [], window: { start: '09:00', end: '17:00' } })).toBe('Choose at least one sending day.');
    expect(sendScheduleError({ days: ['Mon', 'Funday'], window: { start: '09:00', end: '17:00' } }))
      .toBe('Sending days must be Mon, Tue, Wed, Thu, Fri, Sat or Sun.');
    expect(sendScheduleError({ days: ['Mon'], window: { start: '', end: '17:00' } }))
      .toBe('Set the sending window start and end as 24-hour HH:MM times.');
    expect(sendScheduleError({ days: ['Mon'], window: { start: '09:00', end: '5pm' } }))
      .toBe('Set the sending window start and end as 24-hour HH:MM times.');
    expect(sendScheduleError({ days: ['Mon'] })).toBe('Set the sending window start and end as 24-hour HH:MM times.');
  });

  it('keeps only the days and window of a complete schedule', () => {
    expect(parseSendSchedule({ ...OFFICE_HOURS, window: { ...OFFICE_HOURS.window, extra: 1 }, note: 'x' })).toEqual(OFFICE_HOURS);
    expect(parseSendSchedule({ days: [], window: OFFICE_HOURS.window })).toBeNull();
  });

  it('accepts time zone names the runtime knows', () => {
    expect(timezoneError('UTC')).toBeNull();
    expect(timezoneError('America/New_York')).toBeNull();
    expect(timezoneError('Asia/Kolkata')).toBeNull();
    expect(timezoneError('America/NewYork')).toBe('Choose a valid timezone for the sending window.');
    expect(timezoneError('')).toBe('Choose a valid timezone for the sending window.');
    expect(timezoneError(undefined)).toBe('Choose a valid timezone for the sending window.');
  });
});

describe('PUT /api/campaigns/[id] saves only complete sending windows (M4)', () => {
  const USER = { id: 'user-1', name: 'User', email: 'user@example.com', role: 'USER' as const };
  const params = { params: Promise.resolve({ id: 'cmp-1' }) };
  let campaign: Record<string, unknown>;

  const save = (body: Record<string, unknown>) => putCampaign(
    new NextRequest('http://localhost/api/campaigns/cmp-1', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    params,
  );

  beforeEach(() => {
    vi.resetAllMocks();
    mockedSession.mockResolvedValue(USER);
    campaign = {
      id: 'cmp-1', userId: 'user-1', name: 'Launch', status: 'Draft', audienceCohort: 'Valid',
      timezone: 'UTC', sendSchedule: OFFICE_HOURS, steps: [], senders: [],
    };
    fake.campaign.findUnique.mockImplementation(async () => ({ ...campaign }));
    fake.campaign.update.mockImplementation(async ({ data }: any) => {
      campaign = { ...campaign, ...data };
      return campaign;
    });
    fake.campaignEnrollment.count.mockResolvedValue(1);
    fake.$transaction.mockImplementation(async (fn: (tx: typeof fake) => unknown) => fn(fake));
  });

  it.each([
    ['no days', { days: [], window: { start: '09:00', end: '17:00' } }, 'Choose at least one sending day.'],
    ['a cleared start time', { days: WEEKDAYS, window: { start: '', end: '17:00' } }, 'Set the sending window start and end as 24-hour HH:MM times.'],
    ['an unpadded time', { days: WEEKDAYS, window: { start: '9:00', end: '17:00' } }, 'Set the sending window start and end as 24-hour HH:MM times.'],
    ['null', null, 'The sending schedule needs sending days and a start and end time.'],
  ])('rejects a schedule with %s and saves nothing', async (_label, sendSchedule, error) => {
    const res = await save({ name: 'Renamed', sendSchedule });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(error);
    expect(fake.campaign.update).not.toHaveBeenCalled();
    expect(campaign.sendSchedule).toEqual(OFFICE_HOURS);
    expect(campaign.name).toBe('Launch');
  });

  it('rejects an unknown timezone and saves nothing', async () => {
    const res = await save({ timezone: 'America/NewYork', sendSchedule: OFFICE_HOURS });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Choose a valid timezone for the sending window.');
    expect(fake.campaign.update).not.toHaveBeenCalled();
    expect(campaign.timezone).toBe('UTC');
  });

  it('saves a complete window that runs past midnight, keeping only its days and times', async () => {
    const res = await save({
      timezone: 'Europe/London',
      sendSchedule: { days: ['Mon'], window: { start: '22:00', end: '06:00', note: 'night shift' }, extra: true },
    });

    expect(res.status).toBe(200);
    expect(campaign.timezone).toBe('Europe/London');
    expect(campaign.sendSchedule).toEqual(MONDAY_NIGHT);
  });

  it('leaves the saved window alone when the body does not send one', async () => {
    const res = await save({ name: 'Renamed' });

    expect(res.status).toBe(200);
    expect(campaign.name).toBe('Renamed');
    expect(campaign.sendSchedule).toEqual(OFFICE_HOURS);
    expect(fake.campaign.update.mock.calls[0][0].data).not.toHaveProperty('sendSchedule');
  });
});
