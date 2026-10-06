/**
 * How much the mailboxes GET /api/accounts returns may send, as the send engine enforces it.
 * Kept free of server imports so the Accounts page can use it.
 */

/**
 * The mailbox fields capacity is read from. effectiveDailyCap is the cap on the mailbox's own
 * sends (lib/sendEngine getMailboxCap): null when it has none, which is only while the global
 * rate limits have its daily limit off and it is not warming up.
 */
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
 * Whether the mailboxes' own daily limits are off. With a global rate limit set, the day's
 * allowance it gives (globalDailyCeiling) is the one daily limit and every mailbox shares it;
 * only a warmup ramp still holds a mailbox below it. With neither limit set, each mailbox is
 * held to its own daily limit as before.
 */
export function mailboxDailyLimitsOff(limits?: GlobalRateLimitFields | null): boolean {
  return globalDailyCeiling(limits) !== null;
}

/**
 * The shared daily allowance while the mailboxes' own limits are off: `limit` emails in any 24
 * hours, set by the global limit named in `per`, of which `sent` went out in the last 24 hours.
 */
export interface GlobalDailyAllowance {
  limit: number;
  per: 'minute' | 'hour';
  sent: number;
  remaining: number;
}

/**
 * The shared daily allowance under `limits`, or null when neither is set. `sentLast24Hours` is
 * every send the global limits count over the last 24 hours (lib/rateLimits), whatever its mailbox.
 */
export function globalDailyAllowance(limits: GlobalRateLimitFields | null | undefined, sentLast24Hours: number): GlobalDailyAllowance | null {
  const ceiling = globalDailyCeiling(limits);
  if (!ceiling) return null;
  return { limit: ceiling.cap, per: ceiling.per, sent: sentLast24Hours, remaining: Math.max(0, ceiling.cap - sentLast24Hours) };
}

/**
 * What one mailbox may still send in the current 24 hours: what is left of its own cap, held to
 * what is left of the shared allowance when there is one. A mailbox with no cap of its own (its
 * daily limit off and no warmup) has the whole of the allowance's remainder.
 */
export function mailboxRemaining(mailbox: MailboxCapacityFields, allowance?: GlobalDailyAllowance | null): number {
  const sent = mailbox.sentLast24Hours ?? 0;
  // Without an allowance the mailbox's own limit always applies, so a missing cap falls back to it.
  const cap = allowance ? mailbox.effectiveDailyCap ?? null : mailbox.effectiveDailyCap ?? mailbox.dailyLimit ?? 0;
  const own = cap === null ? Infinity : Math.max(0, cap - sent);
  return allowance ? Math.min(own, allowance.remaining) : own;
}

/**
 * The mailboxes' own caps added up, for when no global limit is set and each is held to its own.
 * Each mailbox may send up to its effective cap (the warmup ramp while it is below the daily
 * limit) in any rolling 24 hours, and its sends in the last 24 hours count toward it. `remaining`
 * adds up what each mailbox has left, so one over its cap (after a lowered limit or a restarted
 * ramp) takes nothing from the others.
 */
export function combinedDailyCapacity(mailboxes: MailboxCapacityFields[]): { sent: number; cap: number; remaining: number } {
  let sent = 0;
  let cap = 0;
  let remaining = 0;
  for (const mailbox of mailboxes) {
    const mailboxCap = mailbox.effectiveDailyCap ?? mailbox.dailyLimit ?? 0;
    const mailboxSent = mailbox.sentLast24Hours ?? 0;
    sent += mailboxSent;
    cap += mailboxCap;
    remaining += Math.max(0, mailboxCap - mailboxSent);
  }
  return { sent, cap, remaining };
}
