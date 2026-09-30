import { isLocalOrTestDatabaseUrl } from '../../lib/devSeed';

/**
 * The integration tests create and delete leads, mailboxes, campaigns, groups,
 * templates and users and change the global settings through the running
 * server, so they only run when asked for by name and against a database that
 * is on this machine or a throwaway test database (M75).
 */
export const INTEGRATION_TESTS_FLAG = 'ARCREACH_INTEGRATION_TESTS';

/**
 * Why the integration tests must not run under `env`, or null when they may:
 * ARCREACH_INTEGRATION_TESTS must be "true" and DATABASE_URL a local or test
 * database (lib/devSeed, as for the dev seed).
 */
export function integrationTestRefusal(env: Record<string, string | undefined>): string | null {
  if (env[INTEGRATION_TESTS_FLAG] !== 'true') {
    return `${INTEGRATION_TESTS_FLAG} is not "true". Set it only for a run against a local or test database.`;
  }
  if (!isLocalOrTestDatabaseUrl(env.DATABASE_URL)) {
    return 'DATABASE_URL does not point at a local database (localhost, 127.0.0.1, ::1 or a socket) or a test database (a name like arcreach_test).';
  }
  return null;
}
