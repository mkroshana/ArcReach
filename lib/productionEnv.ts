/**
 * Production checks for the environment variables the app cannot run safely
 * without: the secrets that sign sessions and unsubscribe links and encrypt
 * stored credentials, and APP_URL, the base of every link in a sent email.
 * Each module that reads one checks it when it loads, and instrumentation.ts
 * checks them all when the server starts, so a production server with a
 * missing, short or published value fails closed instead of running with it.
 *
 * Loaded by middleware.ts (Edge runtime) through lib/sessionSecret and by the
 * editor previews in the browser through lib/emailTracking, so it only checks
 * strings and URLs.
 */
import { isLocalHost } from './devSeed';

/**
 * True in a production server. `next build` evaluates route modules during the
 * "Collecting page data" phase with NODE_ENV=production but no runtime secrets
 * available, so the build phase does not count; the checks still fire at
 * runtime (NEXT_PHASE unset or 'phase-production-server').
 */
export function isProductionRuntime(): boolean {
  return process.env.NODE_ENV === 'production' && process.env.NEXT_PHASE !== 'phase-production-build';
}

const MIN_SECRET_LENGTH = 32;

/**
 * Secret values this repository publishes: the examples .env.example and the
 * README gave, and the dev fallbacks of lib/sessionSecret, lib/secrets and
 * lib/unsubscribeLink. Anyone who has read the repository knows them.
 */
const PUBLISHED_SECRETS = new Set([
  'dev_session_secret_jwt_32_chars_long_placeholder',
  'arcreach_session_secret_jwt_32_chars_long_placeholder',
  'dev_secrets_key_change_me_32_bytes!!',
  'dev_unsubscribe_secret_change_me_32_chars',
  'arcreach_unsubscribe_secret_32_chars_placeholder',
  'whsec_placeholder_secret_key_12345',
  'whsec_e9a182c38d4f7281',
]);

/**
 * A template the README's App Settings block gives in place of a secret, such as
 * `<output of: openssl rand -hex 32>` or, before it, `<your minimum 32 character
 * session signing key>` and `<your webhook signature secret>`, pasted as is.
 */
const TEMPLATE_SECRET = /^\s*<[^<>]*>\s*$/;

/** True for a secret value published in this repository, a README template, or one that says it is a placeholder. */
export function isPublishedSecret(value: string): boolean {
  return PUBLISHED_SECRETS.has(value) || TEMPLATE_SECRET.test(value) || /placeholder|change[_-]?me/i.test(value);
}

/**
 * Throws in a production server when `value`, the secret env var `name`, is
 * unset, shorter than 32 characters or published (isPublishedSecret).
 */
export function requireProductionSecret(name: string, value: string | undefined): void {
  if (!isProductionRuntime()) return;
  const problem = !value
    ? 'must be set'
    : value.length < MIN_SECRET_LENGTH
      ? `must be at least ${MIN_SECRET_LENGTH} characters long`
      : isPublishedSecret(value)
        ? 'must not be a placeholder or a value published in .env.example, the README or a dev fallback'
        : null;
  if (problem) {
    throw new Error(
      `${name} environment variable ${problem} in production. Generate a random one with: openssl rand -hex 32`
    );
  }
}

/**
 * APP_URL hosts that are this machine: lib/devSeed's isLocalHost, with a
 * trailing dot ignored (`localhost.`), plus 0.0.0.0, :: and IPv4-mapped
 * loopback, which URL normalizes to `::ffff:7fxx:xxxx`.
 */
function isLocalAppHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  return isLocalHost(h) || h === '0.0.0.0' || h === '::' || /^::ffff:7f[0-9a-f]{2}:/.test(h);
}

/**
 * Throws in a production server unless `value`, APP_URL, is an https URL on a
 * host other than this machine. Every tracked link, open pixel and unsubscribe
 * link in a sent email is built on it, so without it recipients would get
 * localhost links they cannot open while the sends still succeed.
 */
export function requireProductionAppUrl(value: string | undefined): void {
  if (!isProductionRuntime()) return;
  let url: URL | null;
  try {
    url = value?.trim() ? new URL(value) : null;
  } catch {
    url = null;
  }
  if (!url || url.protocol !== 'https:' || isLocalAppHost(url.hostname)) {
    throw new Error(
      `APP_URL environment variable must be the app's public https URL in production (e.g. https://arcreach-app.azurewebsites.net), not ${value ? `'${value}'` : 'unset'}.`
    );
  }
}

/** Every check above on process.env; instrumentation.ts runs it when the server starts. */
export function checkProductionEnv(): void {
  requireProductionSecret('SESSION_SECRET', process.env.SESSION_SECRET);
  requireProductionSecret('SECRETS_KEY', process.env.SECRETS_KEY);
  requireProductionSecret('UNSUBSCRIBE_SECRET', process.env.UNSUBSCRIBE_SECRET);
  requireProductionAppUrl(process.env.APP_URL);
}
