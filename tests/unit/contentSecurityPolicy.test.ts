import { describe, it, expect, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { SignJWT } from 'jose';
import { getScriptNonceFromHeader } from 'next/dist/server/app-render/get-script-nonce-from-header';
import { buildContentSecurityPolicy } from '../../lib/contentSecurityPolicy';
import { sessionSecretKey } from '../../lib/sessionSecret';
import { middleware } from '../../middleware';

/** The policy's directives by name. */
function directives(policy: string): Record<string, string[]> {
  return Object.fromEntries(
    policy.split(';').map((d) => d.trim().split(/\s+/)).map(([name, ...sources]) => [name, sources]),
  );
}

async function sessionCookie(role = 'USER'): Promise<string> {
  return new SignJWT({ id: 'user-1', role })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h')
    .sign(sessionSecretKey);
}

function request(path: string, cookie?: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    headers: { ...headers, ...(cookie ? { cookie: `user_session=${cookie}` } : {}) },
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('buildContentSecurityPolicy (C4)', () => {
  it('allows scripts only by the nonce and what they load in production, with no eval', () => {
    const d = directives(buildContentSecurityPolicy('abc123==', false));

    expect(d['script-src']).toEqual(["'self'", "'nonce-abc123=='", "'strict-dynamic'"]);
    expect(d['connect-src']).toEqual(["'self'"]);
    expect(d['default-src']).toEqual(["'self'"]);
    expect(d['object-src']).toEqual(["'none'"]);
    expect(d['frame-ancestors']).toEqual(["'none'"]);
    expect(d['base-uri']).toEqual(["'self'"]);
    expect(d['form-action']).toEqual(["'self'"]);
    expect(d['frame-src']).toEqual(["'self'"]);
    expect(d['img-src']).toEqual(["'self'", 'data:', 'blob:', 'https:']);
  });

  it('adds unsafe-eval and hot-reload websockets only in development', () => {
    const d = directives(buildContentSecurityPolicy('abc123==', true));

    expect(d['script-src']).toEqual(["'self'", "'nonce-abc123=='", "'strict-dynamic'", "'unsafe-eval'"]);
    expect(d['connect-src']).toEqual(["'self'", 'ws:', 'wss:']);
  });

  it('keeps inline styles allowed with no nonce in style-src, which would make browsers ignore unsafe-inline', () => {
    for (const isDev of [false, true]) {
      const policy = buildContentSecurityPolicy('abc123==', isDev);
      expect(directives(policy)['style-src']).toEqual(["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com']);
      expect(policy.match(/'nonce-/g)).toHaveLength(1);
    }
  });

  it('allows the Google Sans Flex stylesheet and font files app/globals.css imports from Google Fonts', () => {
    for (const isDev of [false, true]) {
      const d = directives(buildContentSecurityPolicy('abc123==', isDev));
      expect(d['style-src']).toContain('https://fonts.googleapis.com');
      expect(d['font-src']).toEqual(["'self'", 'data:', 'https://fonts.gstatic.com']);
    }
  });

  it('puts the nonce where Next reads it for its own scripts', () => {
    expect(getScriptNonceFromHeader(buildContentSecurityPolicy('bm9uY2U=', false))).toBe('bm9uY2U=');
  });
});

describe('middleware Content-Security-Policy (C4)', () => {
  it('sends a fresh nonce policy with a signed-in page and forwards it and x-nonce to rendering', async () => {
    const cookie = await sessionCookie();
    const first = await middleware(request('/campaigns', cookie));
    const second = await middleware(request('/campaigns', cookie));

    const policy = first.headers.get('content-security-policy')!;
    const nonce = getScriptNonceFromHeader(policy)!;
    expect(first.status).toBe(200);
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(first.headers.get('x-middleware-request-content-security-policy')).toBe(policy);
    expect(first.headers.get('x-middleware-request-x-nonce')).toBe(nonce);
    expect(first.headers.get('x-middleware-override-headers')).toContain('x-nonce');
    expect(getScriptNonceFromHeader(second.headers.get('content-security-policy')!)).not.toBe(nonce);
  });

  it('overwrites an x-nonce the client sent with the one in the policy', async () => {
    const res = await middleware(request('/leads', await sessionCookie(), { 'x-nonce': 'attacker' }));

    const nonce = getScriptNonceFromHeader(res.headers.get('content-security-policy')!);
    expect(res.headers.get('x-middleware-request-x-nonce')).toBe(nonce);
    expect(nonce).not.toBe('attacker');
  });

  it('sends the policy with /login signed out and with a bad cookie, still clearing the bad cookie', async () => {
    const signedOut = await middleware(request('/login'));
    const badCookie = await middleware(request('/login', 'not-a-jwt'));

    expect(signedOut.headers.get('content-security-policy')).toContain("'strict-dynamic'");
    expect(badCookie.headers.get('content-security-policy')).toContain("'strict-dynamic'");
    expect(badCookie.cookies.get('user_session')?.value).toBe('');
  });

  it('adds unsafe-eval to the page policy only when NODE_ENV is development', async () => {
    const cookie = await sessionCookie();
    // Set explicitly: CI runs the unit tests with NODE_ENV=development.
    vi.stubEnv('NODE_ENV', 'production');
    expect(directives((await middleware(request('/', cookie))).headers.get('content-security-policy')!)['script-src'])
      .not.toContain("'unsafe-eval'");

    vi.stubEnv('NODE_ENV', 'development');
    expect(directives((await middleware(request('/', cookie))).headers.get('content-security-policy')!)['script-src'])
      .toContain("'unsafe-eval'");
  });

  it('leaves API routes, including the unsubscribe page with its own policy, without the page policy or a nonce', async () => {
    const cookie = await sessionCookie();
    for (const res of [
      await middleware(request('/api/leads', cookie)),
      await middleware(request('/api/unsubscribe?token=t')),
      await middleware(request('/api/track/click/d1?url=https%3A%2F%2Fexample.com')),
    ]) {
      expect(res.headers.get('content-security-policy')).toBeNull();
      expect(res.headers.get('x-middleware-request-x-nonce')).toBeNull();
      expect(res.headers.get('x-middleware-request-content-security-policy')).toBeNull();
    }
  });

  it('still redirects a signed-out page to /login and a non-admin away from /admin', async () => {
    const signedOut = await middleware(request('/campaigns'));
    const nonAdmin = await middleware(request('/admin', await sessionCookie('USER')));

    expect(new URL(signedOut.headers.get('location')!).pathname).toBe('/login');
    expect(new URL(nonAdmin.headers.get('location')!).pathname).toBe('/');
  });
});
