/**
 * The combined sending capacity of the mailboxes GET /api/accounts returns, as the send engine
 * enforces it. Kept free of server imports so the Accounts page can use it.
 */

/** The mailbox fields capacity is read from: effectiveDailyCap is getEffectiveDailyCap's cap. */
export interface MailboxCapacityFields {
  dailyLimit?: number | null;
  effectiveDailyCap?: number | null;
  sentLast24Hours?: number | null;
}

/** The global rate limits from Settings (rateLimitMinute and rateLimitHour); null or 0 is no limit. */
export interface GlobalRateLimitFields {
  minute?: number | null;
  hour?: number | null;
}

/**
 * The most the global rate limits let all mailboxes together send in any 24 hours, and which
 * of the two sets it: lib/rateLimits holds every rolling minute and hour to its limit, so a day
 * gets at most 1,440 and 24 of them. Null when neither limit is set.
 */
export function globalDailyCeiling(limits?: GlobalRateLimitFields | null): { cap: number; per: 'minute' | 'hour' } | null {
  const byMinute = limits?.minute && limits.minute > 0 ? limits.minute * 1440 : null;
  const byHour = limits?.hour && limits.hour > 0 ? limits.hour * 24 : null;
  if (byHour !== null && (byMinute === null || byHour <= byMinute)) return { cap: byHour, per: 'hour' };
  if (byMinute !== null) return { cap: byMinute, per: 'minute' };
  return null;
}

/**
 * Each mailbox may send up to its effective cap (the warmup ramp while it is below the daily
 * limit) in any rolling 24 hours, and its sends in the last 24 hours count toward it. `remaining`
 * adds up what each mailbox has left, so one over its cap (after a lowered limit or a restarted
 * ramp) takes nothing from the others.
 *
 * The global rate limits apply to all mailboxes together, so `cap` and `remaining` are held to
 * what those allow in a day (globalDailyCeiling). `mailboxCap` is the mailboxes' own total, and
 * `limitedBy` names the global limit when it is the lower of the two. The global limits also
 * count failed sends, which `sent` leaves out, so `remaining` is an upper bound.
 */
export function combinedDailyCapacity(
  mailboxes: MailboxCapacityFields[],
  globalLimits?: GlobalRateLimitFields | null
): { sent: number; cap: number; remaining: number; mailboxCap: number; limitedBy: 'minute' | 'hour' | null } {
  let sent = 0;
  let mailboxCap = 0;
  let mailboxRemaining = 0;
  for (const mailbox of mailboxes) {
    const cap = mailbox.effectiveDailyCap ?? mailbox.dailyLimit ?? 0;
    const mailboxSent = mailbox.sentLast24Hours ?? 0;
    sent += mailboxSent;
    mailboxCap += cap;
    mailboxRemaining += Math.max(0, cap - mailboxSent);
  }

  const ceiling = globalDailyCeiling(globalLimits);
  if (!ceiling) return { sent, cap: mailboxCap, remaining: mailboxRemaining, mailboxCap, limitedBy: null };

  const limited = ceiling.cap < mailboxCap;
  return {
    sent,
    cap: limited ? ceiling.cap : mailboxCap,
    remaining: Math.min(mailboxRemaining, Math.max(0, ceiling.cap - sent)),
    mailboxCap,
    limitedBy: limited ? ceiling.per : null,
  };
}
