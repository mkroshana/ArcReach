import { describe, it, expect, vi, afterEach } from 'vitest';
import { signUnsubscribeToken, verifyUnsubscribeToken } from '../../lib/unsubscribeLink';

/** lib/unsubscribeLink as loaded under `env` (APP_URL and the secret are read when the module loads). */
async function loadWith(env: Record<string, string>) {
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  vi.resetModules();
  return import('../../lib/unsubscribeLink');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('signed unsubscribe tokens (H16)', () => {
  it('gives back the lead and dispatch a token was signed for', () => {
    const token = signUnsubscribeToken('lead-1', 'dispatch-1');

    expect(token).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(verifyUnsubscribeToken(token)).toEqual({ leadId: 'lead-1', dispatchId: 'dispatch-1' });
  });

  it('refuses a token whose lead or dispatch was swapped for another', () => {
    const [lead, dispatch, signature] = signUnsubscribeToken('lead-1', 'dispatch-1').split('.');
    const other = (id: string) => Buffer.from(id).toString('base64url');

    expect(verifyUnsubscribeToken(`${other('lead-2')}.${dispatch}.${signature}`)).toBeNull();
    expect(verifyUnsubscribeToken(`${lead}.${other('dispatch-2')}.${signature}`)).toBeNull();
  });

  it.each(['', 'lead-1', 'a.b', 'a.b.c', 'a.b.c.d'])('refuses the malformed token %j', (token) => {
    expect(verifyUnsubscribeToken(token)).toBeNull();
  });

  it('refuses a token signed under another UNSUBSCRIBE_SECRET', async () => {
    const other = await loadWith({ UNSUBSCRIBE_SECRET: 'another_unsubscribe_secret_of_32_chars_or_more' });

    expect(verifyUnsubscribeToken(other.signUnsubscribeToken('lead-1', 'dispatch-1'))).toBeNull();
  });

  it('refuses to load in production without a 32-character UNSUBSCRIBE_SECRET', async () => {
    await expect(
      loadWith({ NODE_ENV: 'production', APP_URL: 'https://reach.acme.test', UNSUBSCRIBE_SECRET: 'short' })
    ).rejects.toThrow(/UNSUBSCRIBE_SECRET/);
  });
});

describe('List-Unsubscribe headers of campaign emails (H15, H16)', () => {
  it('offers one-click POST to the https link, then the mailto when UNSUBSCRIBE_MAILTO is set', async () => {
    const link = await loadWith({ APP_URL: 'https://reach.acme.test', UNSUBSCRIBE_MAILTO: 'optout@acme.test' });
    const token = link.signUnsubscribeToken('lead-1', 'dispatch-1');

    expect(link.listUnsubscribeHeaders(token)).toEqual({
      'List-Unsubscribe': `<https://reach.acme.test/api/unsubscribe?token=${token}>, <mailto:optout@acme.test?subject=unsubscribe>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
  });

  it('gives only the link without UNSUBSCRIBE_MAILTO, and no one-click POST for a link that is not https', async () => {
    const link = await loadWith({ APP_URL: 'http://localhost:3000', UNSUBSCRIBE_MAILTO: '' });
    const token = link.signUnsubscribeToken('lead-1', 'dispatch-1');

    expect(link.listUnsubscribeHeaders(token)).toEqual({
      'List-Unsubscribe': `<http://localhost:3000/api/unsubscribe?token=${token}>`,
    });
  });
});
