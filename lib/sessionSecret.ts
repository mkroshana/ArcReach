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

if (
  process.env.NODE_ENV === 'production' &&
  (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)
) {
  throw new Error(
    'SESSION_SECRET environment variable must be set and at least 32 characters long in production.'
  );
}

export const sessionSecretKey = new TextEncoder().encode(SESSION_SECRET);
