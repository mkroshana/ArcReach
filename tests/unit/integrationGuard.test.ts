import { describe, it, expect, vi, afterEach } from 'vitest';
import { integrationTestRefusal } from '../integration/guard';

const REMOTE = 'postgresql://arcadmin:secret@arcreach-db.postgres.database.azure.com:5432/arcreach?sslmode=require';
const NEON = 'postgresql://owner:secret@ep-quiet-sun-123456.us-east-2.aws.neon.tech/neondb?sslmode=require';
const LOCAL = 'postgresql://username:password@localhost:5432/arcreach?schema=public';
const CI = 'postgresql://postgres:postgres@localhost:5432/arcreach_test';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('integrationTestRefusal (M75)', () => {
  it('refuses without ARCREACH_INTEGRATION_TESTS=true, even on a local database', () => {
    for (const flag of [undefined, '', '1', 'TRUE', 'yes']) {
      const refusal = integrationTestRefusal({ ARCREACH_INTEGRATION_TESTS: flag, DATABASE_URL: LOCAL });
      expect(refusal, String(flag)).toContain('ARCREACH_INTEGRATION_TESTS is not "true"');
    }
  });

  it('refuses a shared or production database, or a missing or unreadable DATABASE_URL, with the flag set', () => {
    for (const url of [REMOTE, NEON, 'postgresql://postgres@db.internal/latest', undefined, '', 'not a url']) {
      const refusal = integrationTestRefusal({ ARCREACH_INTEGRATION_TESTS: 'true', DATABASE_URL: url });
      expect(refusal, String(url)).toContain('DATABASE_URL does not point at a local database');
    }
  });

  it('allows a local database or a test database with the flag set', () => {
    for (const url of [LOCAL, CI, 'postgresql://postgres@127.0.0.1/arcreach', 'postgresql://postgres@ci-db:5432/arcreach_test']) {
      expect(integrationTestRefusal({ ARCREACH_INTEGRATION_TESTS: 'true', DATABASE_URL: url }), url).toBeNull();
    }
  });
});

describe('tests/integration/api.test.ts (M75)', () => {
  // The file throws on load, before it declares a test, opens a database client or calls the server.
  it('refuses to load without the flag', async () => {
    vi.stubEnv('ARCREACH_INTEGRATION_TESTS', '');
    vi.stubEnv('DATABASE_URL', LOCAL);
    await expect(import('../integration/api.test')).rejects.toThrow(
      'Refusing to run the integration tests: ARCREACH_INTEGRATION_TESTS is not "true".',
    );
  });

  it('refuses to load against a shared database even with the flag', async () => {
    vi.stubEnv('ARCREACH_INTEGRATION_TESTS', 'true');
    vi.stubEnv('DATABASE_URL', NEON);
    await expect(import('../integration/api.test')).rejects.toThrow(
      'Refusing to run the integration tests: DATABASE_URL does not point at a local database',
    );
  });
});
