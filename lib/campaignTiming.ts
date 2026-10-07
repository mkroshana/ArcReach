/**
 * The times the campaign page's Timing panel and the sidebar clock show: an
 * instant in the campaign's time zone and in the viewer's, how long until one
 * arrives, whether the sending window is open and when that changes, and the
 * earliest a sequence can finish. The window itself is worked out by
 * lib/sendSchedule, as the send engine checks it. Pure so the pages can use it.
 */
import {
  SCHEDULE_DAYS, checkSendingWindow, hasSendingSchedule, isValidTimezone, nextWindowClosing, nextWindowOpening, parseSendSchedule,
} from './sendSchedule';

type Instant = Date | string;

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/**
 * How long `ms` is, for a countdown: "45s", "18m 05s", "6h 18m" or "2d 4h".
 * Nothing left, or a time already passed, is "0s".
 */
export function durationText(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (!(seconds > 0)) return '0s';
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${seconds}s`;
}

/**
 * A campaign's sending window at one moment: 'none' without a complete saved
 * schedule and a valid timezone (the send engine then sends nothing); 'open'
 * with when it closes (null when it never does); 'closed' with when it next
 * opens (null when that could not be worked out).
 */
export type WindowState =
  | { state: 'none' }
  | { state: 'open'; closesAt: Date | null }
  | { state: 'closed'; opensAt: Date | null };

export function windowState(timezone: unknown, schedule: unknown, now: Date): WindowState {
  if (!hasSendingSchedule(timezone, schedule)) return { state: 'none' };
  const zone = timezone as string;
  if (checkSendingWindow(zone, schedule, now)) return { state: 'open', closesAt: nextWindowClosing(zone, schedule, now) };
  return { state: 'closed', opensAt: nextWindowOpening(zone, schedule, now) };
}

/**
 * When an email due at `dueAt` can go out: then, when the sending window is
 * open then, else when it next opens, which is the date the send engine moves
 * the lead to (`held`). Without a complete schedule, or when the opening can't
 * be worked out, the due date stands.
 */
export function sendTime(timezone: unknown, schedule: unknown, dueAt: Date): { at: Date; held: boolean } {
  if (!hasSendingSchedule(timezone, schedule)) return { at: dueAt, held: false };
  const opensAt = nextWindowOpening(timezone as string, schedule, dueAt);
  return opensAt && opensAt.getTime() > dueAt.getTime() ? { at: opensAt, held: true } : { at: dueAt, held: false };
}

/**
 * A stored schedule (a JSON value, or legacy JSON text) in words: "Mon to Fri,
 * 09:00 to 17:00", "Every day, 00:00 to 23:59" or "Mon, Wed, 22:00 to 06:00
 * the next day". Null when it is not a complete schedule.
 */
export function scheduleSummary(schedule: unknown): string | null {
  let stored = schedule;
  if (typeof schedule === 'string') {
    try { stored = JSON.parse(schedule); } catch { return null; }
  }
  const sched = parseSendSchedule(stored);
  if (!sched) return null;

  const picked = SCHEDULE_DAYS.map((day) => sched.days.includes(day));
  const days = SCHEDULE_DAYS.filter((_, index) => picked[index]);
  const first = picked.indexOf(true);
  const last = picked.lastIndexOf(true);
  const oneRun = picked.slice(first, last + 1).every(Boolean);
  const dayText = days.length === 7 ? 'Every day'
    : oneRun && days.length >= 3 ? `${days[0]} to ${days[days.length - 1]}`
      : days.join(', ');
  const overnight = sched.window.start > sched.window.end;
  return `${dayText}, ${sched.window.start} to ${sched.window.end}${overnight ? ' the next day' : ''}`;
}

/** The viewer's own time zone, as the browser reports it. */
export function viewerTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

// Formatters are costly to build and these are asked for every second.
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(kind: string, locale: string | undefined, timeZone: string | undefined, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${kind}|${locale ?? ''}|${timeZone ?? ''}`;
  let format = formatters.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, { ...options, timeZone });
    formatters.set(key, format);
  }
  return format;
}

/** `timeZone` when it is one this runtime knows, else undefined: the runtime's own zone. */
function knownZone(timeZone: string | null | undefined): string | undefined {
  return isValidTimezone(timeZone) ? timeZone : undefined;
}

/**
 * A zone's short name at an instant: "EDT" or "PST" where it has one, else its
 * offset as "UTC+5:30". Always the US English name, since other locales write
 * even New York as an offset, and "UTC" for the "GMT" Intl writes offsets with.
 */
export function zoneShortName(at: Instant, timeZone: string | null | undefined): string {
  const parts = formatter('zoneName', 'en-US', knownZone(timeZone), { timeZoneName: 'short' }).formatToParts(new Date(at));
  const name = parts.find((part) => part.type === 'timeZoneName')?.value ?? '';
  return name.replace(/^GMT/, 'UTC');
}

/**
 * An instant as a date and 24-hour time in `timeZone`, "Thu 9 Oct, 09:00 EDT",
 * or without the zone's name when `zoneName` is false. The order of the date's
 * parts follows `locale` (the runtime's when not given).
 */
export function zonedDateTime(at: Instant, timeZone: string | null | undefined, options: { zoneName?: boolean; locale?: string } = {}): string {
  const dateTime = formatter('dateTime', options.locale, knownZone(timeZone), {
    weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(at));
  return options.zoneName === false ? dateTime : `${dateTime} ${zoneShortName(at, timeZone)}`;
}

/** An instant's 24-hour clock time with seconds in `timeZone`: "09:42:07". */
export function zonedClock(at: Instant, timeZone: string | null | undefined, locale?: string): string {
  return formatter('clock', locale, knownZone(timeZone), {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).format(new Date(at));
}

/** An instant's date in `timeZone`: "Thu 9 Oct". */
export function zonedDate(at: Instant, timeZone: string | null | undefined, locale?: string): string {
  return formatter('date', locale, knownZone(timeZone), { weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(at));
}

/** Minutes `timeZone` is ahead of UTC at an instant (negative when behind): -240 for New York in summer. */
export function utcOffsetMinutes(at: Instant, timeZone: string | null | undefined): number {
  const parts = formatter('offset', 'en-US', knownZone(timeZone), { timeZoneName: 'longOffset' }).formatToParts(new Date(at));
  const offset = /([+-])(\d{2}):(\d{2})/.exec(parts.find((part) => part.type === 'timeZoneName')?.value ?? '');
  if (!offset) return 0; // plain "GMT"
  return (offset[1] === '-' ? -1 : 1) * (Number(offset[2]) * 60 + Number(offset[3]));
}

/** "UTC-04:00", "UTC+05:30" or "UTC+00:00": `timeZone`'s offset at an instant. */
export function utcOffsetText(at: Instant, timeZone: string | null | undefined): string {
  const minutes = utcOffsetMinutes(at, timeZone);
  const size = Math.abs(minutes);
  return `UTC${minutes < 0 ? '-' : '+'}${String(Math.floor(size / 60)).padStart(2, '0')}:${String(size % 60).padStart(2, '0')}`;
}

/**
 * A zone's name at an instant with its offset, "EDT (UTC-04:00)", or the
 * offset alone where the zone has no short name of its own.
 */
export function zoneLabel(at: Instant, timeZone: string | null | undefined): string {
  const name = zoneShortName(at, timeZone);
  const offset = utcOffsetText(at, timeZone);
  return !name || name.startsWith('UTC') ? offset : `${name} (${offset})`;
}

/**
 * How far `timeZone` is from `otherZone` at an instant: "9h 30m ahead",
 * "3h behind", or null when both read the same time.
 */
export function zoneDifferenceText(at: Instant, timeZone: string | null | undefined, otherZone: string | null | undefined): string | null {
  const minutes = utcOffsetMinutes(at, timeZone) - utcOffsetMinutes(at, otherZone);
  if (minutes === 0) return null;
  return `${durationText(Math.abs(minutes) * MINUTE_MS)} ${minutes > 0 ? 'ahead' : 'behind'}`;
}

/**
 * An instant in both zones, for a page that shows every time twice: in the
 * campaign's zone with the zone's name, and in the viewer's without it (the
 * page says whose it is). `viewer` is null when both zones read the same time
 * then, so the page shows it once.
 */
export function bothZones(
  at: Instant, campaignZone: string | null | undefined, viewerZone: string | null | undefined, locale?: string,
): { campaign: string; viewer: string | null } {
  const same = utcOffsetMinutes(at, campaignZone) === utcOffsetMinutes(at, viewerZone);
  return {
    campaign: zonedDateTime(at, campaignZone, { locale }),
    viewer: same ? null : zonedDateTime(at, viewerZone, { zoneName: false, locale }),
  };
}

/**
 * The earliest the last email of a campaign's sequence can go out, by wait
 * days alone. A lead waiting for step s gets it no earlier than its send date
 * (or now, once that has passed), and each later step its wait days after the
 * one before, as the send engine schedules them. `waiting` has, per step, the
 * leads waiting for it and the latest of their send dates. The sending window,
 * rate limits and mailbox caps can only make the real date later, and a reply,
 * unsubscribe or bounce ends a lead early. Null when no lead is waiting.
 */
export function earliestFinish(
  steps: Array<{ stepOrder: number; waitDays?: unknown }>,
  waiting: Array<{ stepOrder: number; active: number; lastDueAt?: Instant | null }>,
  now: Date,
): Date | null {
  let finish: number | null = null;
  for (const group of waiting) {
    if (!(group.active > 0) || !steps.some((step) => step.stepOrder === group.stepOrder)) continue;
    const due = group.lastDueAt ? new Date(group.lastDueAt).getTime() : NaN;
    const sent = Number.isNaN(due) ? now.getTime() : Math.max(due, now.getTime());
    const laterWaitDays = steps
      .filter((step) => step.stepOrder > group.stepOrder)
      .reduce((days, step) => days + (Number(step.waitDays) || 0), 0);
    const last = sent + laterWaitDays * DAY_MS;
    if (finish === null || last > finish) finish = last;
  }
  return finish === null ? null : new Date(finish);
}
