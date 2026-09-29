/**
 * A campaign's sending window: the weekdays it may send on and a daily 24-hour
 * HH:MM start and end in the campaign's timezone. A window whose start is later
 * than its end runs past midnight into the next day. The send engine keeps an
 * incomplete window closed, so the PUT route and the campaign page refuse to
 * save one. Pure string work so the campaign page runs the same checks.
 */

export const SCHEDULE_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export type SendSchedule = { days: string[]; window: { start: string; end: string } };

/** 24-hour HH:MM, 00:00 to 23:59. */
const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHhMm(value: unknown): value is string {
  return typeof value === 'string' && HH_MM.test(value);
}

/** Why `schedule` is not a complete sending window, or null when it is. */
export function sendScheduleError(schedule: unknown): string | null {
  if (!isObject(schedule)) return 'The sending schedule needs sending days and a start and end time.';
  const { days, window } = schedule;
  if (!Array.isArray(days) || days.length === 0) return 'Choose at least one sending day.';
  if (!days.every((day) => SCHEDULE_DAYS.includes(day))) {
    return 'Sending days must be Mon, Tue, Wed, Thu, Fri, Sat or Sun.';
  }
  if (!isObject(window) || !isHhMm(window.start) || !isHhMm(window.end)) {
    return 'Set the sending window start and end as 24-hour HH:MM times.';
  }
  return null;
}

/** The schedule's days and window when it is complete (see sendScheduleError), otherwise null. */
export function parseSendSchedule(schedule: unknown): SendSchedule | null {
  if (sendScheduleError(schedule) !== null) return null;
  const { days, window } = schedule as SendSchedule;
  return { days: [...days], window: { start: window.start, end: window.end } };
}

/** Minutes after midnight of a valid HH:MM time. */
export function minutesOfDay(hhmm: string): number {
  return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
}

/** True when `timezone` is a time zone name (e.g. America/New_York or UTC) this runtime can format dates in. */
export function isValidTimezone(timezone: unknown): timezone is string {
  if (typeof timezone !== 'string' || timezone.trim() === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** Why `timezone` cannot hold a sending window, or null when it can. */
export function timezoneError(timezone: unknown): string | null {
  return isValidTimezone(timezone) ? null : 'Choose a valid timezone for the sending window.';
}
