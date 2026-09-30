/**
 * Guard for the dev default users (lib/db ensureDefaultUsers: admin@arcreach.com and a
 * standard user, both with a published default password). They may only be written to a
 * database on this machine or a throwaway test database, never a shared or production one.
 */

/**
 * Postgres hosts that are this machine: localhost, *.localhost, 127.0.0.0/8, ::1, or a Unix socket path.
 * Also checks APP_URL's host (lib/productionEnv).
 */
export function isLocalHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h) ||
    h === '::1' ||
    h.startsWith('/')
  );
}

/** A database named `test` or with `test` as one of its words (`arcreach_test`, `test-db`), not `latest` or `contest`. */
function isTestDatabaseName(name: string): boolean {
  return /(^|[^a-z0-9])test([^a-z0-9]|$)/i.test(name);
}

/**
 * True when `url` (a Postgres DATABASE_URL) names a database on this machine or a test database.
 * An unset or unparseable URL is not local, so the guard refuses it.
 */
export function isLocalOrTestDatabaseUrl(url: string | undefined): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  let host: string;
  let database: string;
  try {
    // ?host= overrides the URL's host, as in Prisma; a socket connection names its directory there
    // (or percent-encoded in the host) instead of a hostname.
    host = parsed.searchParams.get('host') || decodeURIComponent(parsed.hostname);
    database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  } catch {
    return false;
  }
  return (host !== '' && isLocalHost(host)) || isTestDatabaseName(database);
}

/**
 * Why the dev default users must not be seeded under `env`, or null when they may be:
 * never with NODE_ENV=production, and only into a local or test DATABASE_URL.
 */
export function devSeedRefusal(env: { NODE_ENV?: string; DATABASE_URL?: string }): string | null {
  if (env.NODE_ENV === 'production') {
    return 'NODE_ENV is production.';
  }
  if (!isLocalOrTestDatabaseUrl(env.DATABASE_URL)) {
    return 'DATABASE_URL does not point at a local database (localhost, 127.0.0.1, ::1 or a socket) or a test database (a name like arcreach_test).';
  }
  return null;
}
