/**
 * Rules for the global per-minute and per-hour sending limits, shared by PUT /api/settings and the
 * Settings form that calls it.
 *
 * The send engine (checkGlobalRateLimits) treats a stored null or 0 as no limit, so null is saved only
 * for an explicit No Limit choice and every other value must be a whole number from 1 up. An empty
 * or zero field must never reach the database, where it would silently turn limiting off.
 *
 * Has no Node-only imports so client components can check before submitting.
 */

/** The largest value the GlobalSettings rate-limit columns (Postgres integer) hold. */
export const MAX_GLOBAL_RATE_LIMIT = 2_147_483_647;

export type RateLimitPeriod = 'minute' | 'hour';

/** A Settings rate-limit field: `noLimit` is the explicit No Limit choice, otherwise `text` is the typed limit. */
export type RateLimitInput = { noLimit: boolean; text: string };

/** Returns why `value` can not be saved as a global rate limit, or null when it can (null itself is No Limit). */
export function globalRateLimitError(value: unknown, per: RateLimitPeriod): string | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_GLOBAL_RATE_LIMIT) {
    return `Max emails per ${per} must be a whole number from 1 to ${MAX_GLOBAL_RATE_LIMIT.toLocaleString('en-US')}, or No Limit.`;
  }
  return null;
}

/** The form state for a stored limit: a positive number is shown as-is, anything the engine ignores as No Limit. */
export function rateLimitInputFrom(stored: unknown): RateLimitInput {
  return typeof stored === 'number' && stored > 0
    ? { noLimit: false, text: String(stored) }
    : { noLimit: true, text: '' };
}

/** Reads a Settings rate-limit field into the value PUT /api/settings takes, or why it can not be saved. */
export function rateLimitInputValue(input: RateLimitInput, per: RateLimitPeriod): { value: number | null; error: string | null } {
  if (input.noLimit) return { value: null, error: null };
  const text = input.text.trim();
  if (!text) return { value: null, error: `Enter the max emails per ${per}, or choose No Limit.` };
  const value = Number(text);
  const error = globalRateLimitError(value, per);
  return { value: error ? null : value, error };
}
