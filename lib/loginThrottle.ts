/**
 * Sign-in throttle: at most LOGIN_MAX_ATTEMPTS attempts per client IP and per account email in
 * any LOGIN_WINDOW_MS. Counts are kept in this process's memory, which covers ArcReach while it
 * runs as a single App Service instance; scaled out, each instance would count on its own.
 */

export const LOGIN_MAX_ATTEMPTS = 10;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
/** How often expired keys are dropped, so addresses and emails seen once do not pile up. */
const SWEEP_INTERVAL_MS = 60 * 1000;

/** Start times of the counted attempts per `ip:` or `account:` key, oldest first. */
const attempts = new Map<string, number[]>();
let lastSweep = 0;

export type LoginAttempt =
  | { allowed: true; succeeded: () => void }
  | { allowed: false; retryAfterSeconds: number };

/**
 * The client address App Service's front end appended to X-Forwarded-For, without its port. The
 * last entry is used because anything before it was sent by the client and can be forged.
 */
export function clientIp(headers: Headers): string {
  const entries = (headers.get('x-forwarded-for') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const last = entries[entries.length - 1];
  if (!last) return 'unknown';
  const bracketed = /^\[([^\]]+)\]/.exec(last);
  if (bracketed) return bracketed[1];
  // One colon is IPv4 with a port; more is a bare IPv6 address.
  const parts = last.split(':');
  return parts.length === 2 ? parts[0] : last;
}

/**
 * Checks and counts one sign-in attempt from `ip` for `email` in the same synchronous step, so
 * concurrent requests cannot all pass the check before any of them is counted. A refused attempt
 * is not counted and says how long until the oldest counted one leaves the window. Call
 * `succeeded` after a successful sign-in: that attempt stops counting against the IP and the
 * account's count starts over.
 */
export function beginLoginAttempt(ip: string, email: string, now: number = Date.now()): LoginAttempt {
  sweep(now);
  const ipKey = `ip:${ip}`;
  const accountKey = `account:${email.trim().toLowerCase()}`;

  let retryAfterMs = 0;
  for (const key of [ipKey, accountKey]) {
    const times = live(key, now);
    if (times.length >= LOGIN_MAX_ATTEMPTS) {
      retryAfterMs = Math.max(retryAfterMs, times[times.length - LOGIN_MAX_ATTEMPTS] + LOGIN_WINDOW_MS - now);
    }
  }
  if (retryAfterMs > 0) return { allowed: false, retryAfterSeconds: Math.ceil(retryAfterMs / 1000) };

  for (const key of [ipKey, accountKey]) attempts.set(key, [...live(key, now), now]);

  return {
    allowed: true,
    succeeded: () => {
      const times = attempts.get(ipKey);
      const index = times ? times.indexOf(now) : -1;
      if (times && index >= 0) times.splice(index, 1);
      attempts.delete(accountKey);
    },
  };
}

/** The key's attempts still inside the window at `now`. */
function live(key: string, now: number): number[] {
  return (attempts.get(key) ?? []).filter((t) => now - t < LOGIN_WINDOW_MS);
}

function sweep(now: number) {
  if (now - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = now;
  for (const [key, times] of attempts) {
    if (times.length === 0 || now - times[times.length - 1] >= LOGIN_WINDOW_MS) attempts.delete(key);
  }
}
