/**
 * Centralized session signing secret.
 *
 * Imported by both lib/session.ts (Node runtime) and middleware.ts (Edge runtime),
 * so it must only use APIs available in both (TextEncoder + process.env are fine).
 * Keeping a single source of truth ensures middleware and route verification never
 * drift apart, and the production guard fails closed in every runtime that loads it.
 */
const DEV_FALLBACK_SECRET = 'dev_session_secret_jwt_32_chars_long_placeholder';

const SESSION_SECRET = process.env.SESSION_SECRET || DEV_FALLBACK_SECRET;

// `next build` evaluates route modules during the "Collecting page data" phase with
// NODE_ENV=production but no runtime secrets available. Skip the guard during that
// phase; it still fires at runtime (NEXT_PHASE unset or 'phase-production-server'),
// which is where a missing/short secret actually matters.
const isBuildPhase = process.env.NEXT_PHASE === 'phase-production-build';

if (
  !isBuildPhase &&
  process.env.NODE_ENV === 'production' &&
  (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)
) {
  throw new Error(
    'SESSION_SECRET environment variable must be set and at least 32 characters long in production.'
  );
}

export const sessionSecretKey = new TextEncoder().encode(SESSION_SECRET);
