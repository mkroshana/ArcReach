import { describe, it, expect, vi, afterEach } from 'vitest';
import { requireProductionAppUrl, requireProductionSecret } from '../../lib/productionEnv';

vi.mock('../../lib/workerDaemon', () => ({ startBackgroundWorker: vi.fn() }));

/** A random 64-hex-character secret, as `openssl rand -hex 32` makes. */
const RANDOM = 'b3f1c8e2a94d7065f2e1c3b4a5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8';

/** Stubs `env` (with NEXT_PHASE unset, as at runtime) and loads `module` fresh, so its load-time checks run under it. */
async function loadWith<T>(module: () => Promise<T>, env: Record<string, string | undefined>): Promise<T> {
  vi.stubEnv('NEXT_PHASE', undefined);
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  vi.resetModules();
  return module();
}

const production = (env: Record<string, string | undefined> = {}) => {
  vi.stubEnv('NEXT_PHASE', undefined);
  vi.stubEnv('NODE_ENV', 'production');
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.clearAllMocks();
});

describe('production secrets (M74)', () => {
  it.each([
    ['unset', undefined, /must be set/],
    ['empty', '', /must be set/],
    ['short', 'a1b2c3d4', /at least 32 characters/],
    ['the old .env.example SESSION_SECRET', 'arcreach_session_secret_jwt_32_chars_long_placeholder', /published/],
    ['the SESSION_SECRET dev fallback', 'dev_session_secret_jwt_32_chars_long_placeholder', /published/],
    ['the SECRETS_KEY dev fallback', 'dev_secrets_key_change_me_32_bytes!!', /published/],
    ['the old .env.example UNSUBSCRIBE_SECRET', 'arcreach_unsubscribe_secret_32_chars_placeholder', /published/],
    ['a value saying it is a placeholder', 'my-own-PLACEHOLDER-value-that-is-long-enough', /published/],
    ['a value saying change me', 'please-changeme-before-going-live-0123456789', /published/],
    ['the README App Settings template', '<output of: openssl rand -hex 32>', /published/],
    ['the old README SESSION_SECRET template', '<your minimum 32 character session signing key>', /published/],
  ])('refuses %s in production', (_label, value, message) => {
    production();
    expect(() => requireProductionSecret('SESSION_SECRET', value)).toThrow(message);
    expect(() => requireProductionSecret('SESSION_SECRET', value)).toThrow(/^SESSION_SECRET /);
  });

  it('accepts a random secret of at least 32 characters in production', () => {
    production();
    expect(() => requireProductionSecret('SECRETS_KEY', RANDOM)).not.toThrow();
  });

  it('checks nothing outside production or while `next build` collects page data', () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect(() => requireProductionSecret('SESSION_SECRET', undefined)).not.toThrow();

    production({ NEXT_PHASE: 'phase-production-build' });
    expect(() => requireProductionSecret('SESSION_SECRET', undefined)).not.toThrow();
  });

  it('keeps lib/sessionSecret, lib/secrets and lib/unsubscribeLink from loading in production with a published value', async () => {
    const env = { NODE_ENV: 'production', APP_URL: 'https://reach.acme.test', SESSION_SECRET: RANDOM, SECRETS_KEY: RANDOM, UNSUBSCRIBE_SECRET: RANDOM };

    await expect(
      loadWith(() => import('../../lib/sessionSecret'), { ...env, SESSION_SECRET: 'arcreach_session_secret_jwt_32_chars_long_placeholder' })
    ).rejects.toThrow(/SESSION_SECRET/);
    await expect(
      loadWith(() => import('../../lib/secrets'), { ...env, SECRETS_KEY: 'dev_secrets_key_change_me_32_bytes!!' })
    ).rejects.toThrow(/SECRETS_KEY/);
    await expect(
      loadWith(() => import('../../lib/unsubscribeLink'), { ...env, UNSUBSCRIBE_SECRET: 'arcreach_unsubscribe_secret_32_chars_placeholder' })
    ).rejects.toThrow(/UNSUBSCRIBE_SECRET/);

    const secrets = await loadWith(() => import('../../lib/secrets'), env);
    expect(secrets.decryptSecret(secrets.encryptSecret('imap-password'))).toBe('imap-password');
  });
});

describe('production APP_URL (M73)', () => {
  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['not a URL', 'arcreach-app.azurewebsites.net'],
    ['http', 'http://arcreach-app.azurewebsites.net'],
    ['localhost', 'https://localhost:3000'],
    ['a *.localhost name', 'https://arcreach.localhost'],
    ['127.0.0.1', 'https://127.0.0.1:3000'],
    ['::1', 'https://[::1]:3000'],
    ['localhost with a trailing dot', 'https://localhost.'],
    ['0.0.0.0', 'https://0.0.0.0'],
    ['::', 'https://[::]'],
    ['IPv4-mapped loopback', 'https://[::ffff:127.0.0.1]'],
    ['only whitespace', '   '],
  ])('refuses %s in production', (_label, value) => {
    production();
    expect(() => requireProductionAppUrl(value)).toThrow(/APP_URL/);
  });

  it('accepts a public https URL in production, and anything outside production or during the build', () => {
    production();
    expect(() => requireProductionAppUrl('https://arcreach-app.azurewebsites.net')).not.toThrow();

    vi.stubEnv('NODE_ENV', 'development');
    expect(() => requireProductionAppUrl(undefined)).not.toThrow();

    production({ NEXT_PHASE: 'phase-production-build' });
    expect(() => requireProductionAppUrl('http://localhost:3000')).not.toThrow();
  });

  it('keeps lib/emailTracking from loading on a production server without a public https APP_URL', async () => {
    await expect(loadWith(() => import('../../lib/emailTracking'), { NODE_ENV: 'production', APP_URL: undefined })).rejects.toThrow(/APP_URL/);
    await expect(loadWith(() => import('../../lib/emailTracking'), { NODE_ENV: 'production', APP_URL: 'http://localhost:3000' })).rejects.toThrow(/APP_URL/);

    const tracking = await loadWith(() => import('../../lib/emailTracking'), { NODE_ENV: 'production', APP_URL: 'https://reach.acme.test' });
    expect(tracking.unsubscribeUrl('t')).toBe('https://reach.acme.test/api/unsubscribe?token=t');
  });

  it('builds links on APP_URL without surrounding whitespace or a trailing slash', async () => {
    const tracking = await loadWith(() => import('../../lib/emailTracking'), { NODE_ENV: 'production', APP_URL: ' https://reach.acme.test/ ' });
    expect(tracking.unsubscribeUrl('t')).toBe('https://reach.acme.test/api/unsubscribe?token=t');
    expect(tracking.injectTrackingPixel('<p>Hi</p>', 'd1')).toContain('src="https://reach.acme.test/api/track/open/d1"');
  });

  it('keeps the local fallback outside production', async () => {
    const tracking = await loadWith(() => import('../../lib/emailTracking'), { NODE_ENV: 'development', APP_URL: undefined });
    expect(tracking.unsubscribeUrl('t')).toBe('http://localhost:3000/api/unsubscribe?token=t');
  });
});

describe('server startup (instrumentation register)', () => {
  const valid = { NODE_ENV: 'production', NEXT_RUNTIME: 'nodejs', APP_URL: 'https://reach.acme.test', SESSION_SECRET: RANDOM, SECRETS_KEY: RANDOM, UNSUBSCRIBE_SECRET: RANDOM };

  it.each([
    ['APP_URL', 'http://localhost:3000'],
    ['SESSION_SECRET', undefined],
    ['SECRETS_KEY', 'dev_secrets_key_change_me_32_bytes!!'],
    ['UNSUBSCRIBE_SECRET', 'arcreach_unsubscribe_secret_32_chars_placeholder'],
  ])('fails in production with a bad %s before starting the send worker', async (name, value) => {
    const { register } = await loadWith(() => import('../../instrumentation'), { ...valid, [name]: value });
    const { startBackgroundWorker } = await import('../../lib/workerDaemon');

    await expect(register()).rejects.toThrow(new RegExp(name));
    expect(startBackgroundWorker).not.toHaveBeenCalled();
  });

  it('starts the send worker when every required production variable is good', async () => {
    const { register } = await loadWith(() => import('../../instrumentation'), valid);
    const { startBackgroundWorker } = await import('../../lib/workerDaemon');

    await register();
    expect(startBackgroundWorker).toHaveBeenCalledTimes(1);
  });
});
