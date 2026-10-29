const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Monday first, as the dashboard's bars read. */
export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

export type WeekdaySends = { day: (typeof WEEKDAYS)[number]; sent: number };

/**
 * The weekday of a trend bucket's label ('Oct 24', from lib/engagementMetrics).
 * The label has no year: it is in the last 90 days, so it takes today's year
 * unless that puts it in the future. A calendar date's weekday is the same in
 * every time zone, so the server's zone does not matter. Null when unreadable.
 */
export function labelWeekday(label: string, today: Date): number | null {
  const [mon, dayText] = label.trim().split(/\s+/);
  const month = MONTHS.indexOf(mon);
  const day = Number(dayText);
  if (month < 0 || !Number.isInteger(day) || day < 1 || day > 31) return null;
  let year = today.getFullYear();
  // A day or two of slack for a server ahead of the viewer's zone.
  if (new Date(year, month, day) > new Date(year, today.getMonth(), today.getDate() + 2)) year -= 1;
  // getDay() counts from Sunday; shift so Monday is 0.
  return (new Date(year, month, day).getDay() + 6) % 7;
}

/**
 * Emails sent on each weekday over the trend's days, and the busiest weekday
 * (the earliest in the week on a tie). Busiest is null when nothing was sent.
 */
export function sendsByWeekday(
  trends: { name: string; sent: number }[],
  today: Date = new Date(),
): { days: WeekdaySends[]; busiest: WeekdaySends | null } {
  const totals = WEEKDAYS.map(() => 0);
  for (const bucket of trends) {
    const weekday = labelWeekday(bucket.name, today);
    if (weekday !== null) totals[weekday] += Number(bucket.sent) || 0;
  }
  const days = WEEKDAYS.map((day, i) => ({ day, sent: totals[i] }));
  const busiest = days.reduce<WeekdaySends | null>((best, d) => (d.sent > (best?.sent ?? 0) ? d : best), null);
  return { days, busiest };
}
