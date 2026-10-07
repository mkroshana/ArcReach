/**
 * A campaign's sending window: the weekdays it may send on and a daily 24-hour
 * HH:MM start and end in the campaign's timezone. A window whose start is later
 * than its end runs past midnight into the next day. The send engine keeps a
 * missing or incomplete window closed, so the PUT route and the campaign page
 * refuse to save an incomplete one, a campaign that is not Active may be saved
 * with none, and a campaign may only be Active with a complete one.
 * Pure string work so the campaign page runs the same checks, and shows when
 * the window the send engine checks is open, next opens and closes.
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

/**
 * Why a campaign without a complete sending schedule may not be made Active or
 * have its leads queued. The send engine never opens its window and sets it
 * back to Draft.
 */
export const SCHEDULE_REQUIRED_ERROR =
  "Set a sending schedule first: save sending days and a start and end time on the campaign's Schedule tab. A campaign without one sends nothing and can't be made Active.";

/**
 * Whether a campaign's timezone and stored schedule (a JSON value, or legacy
 * JSON text) are a complete sending window, which it needs to be Active.
 */
export function hasSendingSchedule(timezone: unknown, schedule: unknown): boolean {
  if (!isValidTimezone(timezone)) return false;
  if (typeof schedule !== 'string') return parseSendSchedule(schedule) !== null;
  try {
    return parseSendSchedule(JSON.parse(schedule)) !== null;
  } catch {
    return false;
  }
}

const MINUTE_MS = 60_000;
const MINUTES_PER_DAY = 24 * 60;

type LocalTime = { day: string; minute: number };

/** Reads an instant's weekday ('Mon'..'Sun') and minute of the day in `timezone`, or null for an unknown timezone. */
function localClock(timezone: unknown): ((at: number) => LocalTime) | null {
  if (!isValidTimezone(timezone)) return null;
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  return (at) => {
    const parts = format.formatToParts(at);
    const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    return { day: part('weekday'), minute: (Number(part('hour')) % 24) * 60 + Number(part('minute')) };
  };
}

/** A stored schedule (a JSON value, or legacy JSON text) as a complete window, or null when it is not one. */
function storedSchedule(schedule: unknown): SendSchedule | null {
  return parseSendSchedule(typeof schedule === 'string' ? JSON.parse(schedule) : schedule);
}

/**
 * Whether the window is open at a local weekday and minute; both bounds are
 * inclusive to the minute. A window running past midnight belongs to the day
 * it opens on: Mon 22:00-06:00 sends from Monday 22:00 until Tuesday 06:00.
 */
function windowOpenAt(sched: SendSchedule, local: LocalTime): boolean {
  const start = minutesOfDay(sched.window.start);
  const end = minutesOfDay(sched.window.end);
  if (start <= end) {
    return local.minute >= start && local.minute <= end && sched.days.includes(local.day);
  }
  if (local.minute >= start) return sched.days.includes(local.day);
  if (local.minute <= end) {
    const previousDay = SCHEDULE_DAYS[(SCHEDULE_DAYS.indexOf(local.day) + 6) % 7];
    return sched.days.includes(previousDay);
  }
  return false;
}

/**
 * Whether `now` is inside the campaign's sending window in its timezone. No
 * saved schedule, a schedule with no days or a missing or malformed HH:MM
 * time, an unknown timezone, or any error keeps the window closed.
 */
export function checkSendingWindow(timezone: string, schedule: unknown, now: Date = new Date()): boolean {
  try {
    const sched = storedSchedule(schedule);
    const clock = localClock(timezone);
    if (!sched || !clock) return false;
    return windowOpenAt(sched, clock(now.getTime()));
  } catch (err) {
    console.error('[SendSchedule] Error in checkSendingWindow:', err);
    return false; // fail closed: never send on a window that could not be checked
  }
}

/**
 * The first moment at or after `from` when checkSendingWindow is open: `from`
 * itself when the window is open then, otherwise the minute it next opens in
 * the campaign's timezone, across daylight-saving changes. Null when there is
 * no schedule or the schedule or timezone is invalid, so the window never opens.
 */
export function nextWindowOpening(timezone: string, schedule: unknown, from: Date): Date | null {
  try {
    const sched = storedSchedule(schedule);
    const clock = localClock(timezone);
    if (!sched || !clock) return null;
    if (windowOpenAt(sched, clock(from.getTime()))) return from;

    const start = minutesOfDay(sched.window.start);
    let t = Math.floor(from.getTime() / MINUTE_MS) * MINUTE_MS;
    // Each pass jumps to the next time the local clock reads the start time.
    // The window only opens there, so a week of passes (plus one for a
    // daylight-saving change) always reaches a permitted day.
    for (let pass = 0; pass < 10; pass++) {
      const wait = (start - clock(t).minute + MINUTES_PER_DAY) % MINUTES_PER_DAY || MINUTES_PER_DAY;
      const next = t + wait * MINUTE_MS;
      if (clock(next).minute !== start) {
        // A daylight-saving change moved the clock on the way, possibly past the
        // start time, so find the first open minute one at a time.
        for (let at = t + MINUTE_MS; at <= next; at += MINUTE_MS) {
          if (windowOpenAt(sched, clock(at))) return new Date(at);
        }
      } else if (windowOpenAt(sched, clock(next))) {
        return new Date(next);
      }
      t = next;
    }
    return null;
  } catch (err) {
    console.error('[SendSchedule] Error in nextWindowOpening:', err);
    return null;
  }
}

/**
 * The moment the window that is open at `from` closes: the first minute after
 * `from` when checkSendingWindow is no longer open, across daylight-saving
 * changes. The end time is open to the end of its minute, so a window ending
 * 17:00 closes at 17:01. Null when the window is not open at `from` (or there
 * is no valid schedule or timezone), and when it never closes, as 00:00 to
 * 23:59 on every day never does.
 */
export function nextWindowClosing(timezone: string, schedule: unknown, from: Date): Date | null {
  try {
    const sched = storedSchedule(schedule);
    const clock = localClock(timezone);
    if (!sched || !clock || !windowOpenAt(sched, clock(from.getTime()))) return null;

    const close = (minutesOfDay(sched.window.end) + 1) % MINUTES_PER_DAY;
    let t = Math.floor(from.getTime() / MINUTE_MS) * MINUTE_MS;
    // Each pass jumps to the next time the local clock reads the minute after
    // the end time. An open window only closes there, and stays open through it
    // when the next day's window starts that minute, so a week of passes (plus
    // one for a daylight-saving change) finds the closing if there is one.
    for (let pass = 0; pass < 10; pass++) {
      const wait = (close - clock(t).minute + MINUTES_PER_DAY) % MINUTES_PER_DAY || MINUTES_PER_DAY;
      const next = t + wait * MINUTE_MS;
      if (clock(next).minute !== close) {
        // A daylight-saving change moved the clock on the way, possibly past the
        // end time, so find the first closed minute one at a time.
        for (let at = t + MINUTE_MS; at <= next; at += MINUTE_MS) {
          if (!windowOpenAt(sched, clock(at))) return new Date(at);
        }
      } else if (!windowOpenAt(sched, clock(next))) {
        return new Date(next);
      }
      t = next;
    }
    return null;
  } catch (err) {
    console.error('[SendSchedule] Error in nextWindowClosing:', err);
    return null;
  }
}
