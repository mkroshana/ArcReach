import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import crypto from 'crypto';

/** The User table the login route reads; kept across module resets so the mock keeps its identity. */
const fake = vi.hoisted(() => ({
  prisma: { user: { findUnique: vi.fn(), update: vi.fn() } },
}));

vi.mock('../../lib/db', () => ({ prisma: fake.prisma }));
vi.mock('../../lib/session', () => ({ setSession: vi.fn() }));

import { hashPassword } from '../../lib/auth';

type Throttle = typeof import('../../lib/loginThrottle');
type LoginRoute = typeof import('../../app/api/auth/login/route');

const T0 = Date.UTC(2026, 8, 30, 9, 0, 0);
const WINDOW = 15 * 60 * 1000;
const PASSWORD = 'correct-password-1';
const ACCOUNT = 'ada@example.com';

let passwordHash: string;
/** A fresh copy per test, so no test inherits another's counts. */
let throttle: Throttle;
let login: LoginRoute['POST'];

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD);
});

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  throttle = await import('../../lib/loginThrottle');
  ({ POST: login } = await import('../../app/api/auth/login/route'));
  fake.prisma.user.findUnique.mockImplementation(async ({ where }: any) =>
    where.email === ACCOUNT
      ? { id: 'user-1', name: 'Ada', email: ACCOUNT, role: 'USER', passwordHash, tokenVersion: 0, disabledAt: null }
      : null
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

function loginRequest(email: unknown, password: unknown, ip?: string): NextRequest {
  return new NextRequest('http://localhost/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(ip ? { 'x-forwarded-for': ip } : {}) },
    body: JSON.stringify({ email, password }),
  });
}

describe('clientIp (M48)', () => {
  const ip = (xff?: string) => throttle.clientIp(new Headers(xff === undefined ? {} : { 'x-forwarded-for': xff }));

  it('takes the last X-Forwarded-For entry, the one the front end appended, not one the client sent', () => {
    expect(ip('198.51.100.7, 203.0.113.9:51234')).toBe('203.0.113.9');
    expect(ip('203.0.113.9')).toBe('203.0.113.9');
  });

  it('drops the port from IPv4 and bracketed IPv6, and keeps a bare IPv6 address whole', () => {
    expect(ip('203.0.113.9:443')).toBe('203.0.113.9');
    expect(ip('[2001:db8::1]:443')).toBe('2001:db8::1');
    expect(ip('2001:db8::1')).toBe('2001:db8::1');
  });

  it('falls back to one shared key when there is no header', () => {
    expect(ip()).toBe('unknown');
    expect(ip('')).toBe('unknown');
  });
});

describe('beginLoginAttempt (M48)', () => {
  it('allows 10 attempts on an account in 15 minutes from any IPs and refuses the 11th until the oldest leaves the window', () => {
    for (let i = 0; i < 10; i++) {
      expect(throttle.beginLoginAttempt(`10.0.0.${i}`, ACCOUNT, T0 + i * 1000).allowed).toBe(true);
    }

    const refused = throttle.beginLoginAttempt('10.0.1.1', ACCOUNT, T0 + 60_000);
    expect(refused).toEqual({ allowed: false, retryAfterSeconds: (WINDOW - 60_000) / 1000 });

    // The first attempt leaves the window, which frees exactly one more.
    expect(throttle.beginLoginAttempt('10.0.1.1', ACCOUNT, T0 + WINDOW).allowed).toBe(true);
    expect(throttle.beginLoginAttempt('10.0.1.1', ACCOUNT, T0 + WINDOW).allowed).toBe(false);
  });

  it('counts an account by its email whatever the case and surrounding spaces', () => {
    for (let i = 0; i < 10; i++) throttle.beginLoginAttempt(`10.0.0.${i}`, ' Ada@Example.COM ', T0);
    expect(throttle.beginLoginAttempt('10.0.1.1', ACCOUNT, T0).allowed).toBe(false);
  });

  it('allows 10 attempts from one IP across different emails and refuses the 11th, while another IP still gets in', () => {
    for (let i = 0; i < 10; i++) {
      expect(throttle.beginLoginAttempt('203.0.113.9', `user${i}@example.com`, T0).allowed).toBe(true);
    }
    expect(throttle.beginLoginAttempt('203.0.113.9', 'new@example.com', T0 + 1000)).toEqual({
      allowed: false,
      retryAfterSeconds: (WINDOW - 1000) / 1000,
    });
    expect(throttle.beginLoginAttempt('198.51.100.7', 'new@example.com', T0 + 1000).allowed).toBe(true);
  });

  it('does not count refused attempts, so hammering does not push the window out', () => {
    for (let i = 0; i < 10; i++) throttle.beginLoginAttempt('203.0.113.9', ACCOUNT, T0);
    for (let i = 1; i <= 20; i++) expect(throttle.beginLoginAttempt('203.0.113.9', ACCOUNT, T0 + i * 1000).allowed).toBe(false);

    for (let i = 0; i < 10; i++) expect(throttle.beginLoginAttempt('203.0.113.9', ACCOUNT, T0 + WINDOW).allowed).toBe(true);
  });

  it('stops counting a successful attempt against its IP and starts the account over', () => {
    // Eleven people signing in from one office address.
    for (let i = 0; i < 11; i++) {
      const attempt = throttle.beginLoginAttempt('203.0.113.9', `user${i}@example.com`, T0 + i);
      expect(attempt.allowed).toBe(true);
      if (attempt.allowed) attempt.succeeded();
    }

    // Nine typos, then the right password: the next ten tries on the account are allowed again.
    for (let i = 0; i < 9; i++) throttle.beginLoginAttempt(`10.0.0.${i}`, ACCOUNT, T0);
    const success = throttle.beginLoginAttempt('10.0.0.99', ACCOUNT, T0);
    if (success.allowed) success.succeeded();
    for (let i = 0; i < 10; i++) expect(throttle.beginLoginAttempt(`10.0.2.${i}`, ACCOUNT, T0).allowed).toBe(true);
    expect(throttle.beginLoginAttempt('10.0.3.1', ACCOUNT, T0).allowed).toBe(false);
  });
});

describe('POST /api/auth/login throttling and timing (M48)', () => {
  it('answers an unknown email exactly like a wrong password, after the same PBKDF2 work', async () => {
    const pbkdf2 = vi.spyOn(crypto, 'pbkdf2');
    const iterations = () => pbkdf2.mock.calls.reduce((sum, call) => sum + (call[2] as number), 0);

    const unknown = await login(loginRequest('nobody@example.com', PASSWORD, '203.0.113.1'));
    const unknownIterations = iterations();
    pbkdf2.mockClear();
    const wrong = await login(loginRequest(ACCOUNT, 'wrong-password', '203.0.113.1'));

    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(await unknown.json()).toEqual(await wrong.json());
    expect(unknownIterations).toBe(210000);
    expect(iterations()).toBe(210000);
  });

  it('refuses the 11th attempt on an account with 429 and Retry-After, from a new IP, even with the right password, without the database or PBKDF2', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => login(loginRequest(ACCOUNT, `guess-${i}`, `198.51.100.${i}`)))
    );
    expect(results.map((r) => r.status)).toEqual(Array(10).fill(401));

    fake.prisma.user.findUnique.mockClear();
    const pbkdf2 = vi.spyOn(crypto, 'pbkdf2');
    const res = await login(loginRequest(ACCOUNT, PASSWORD, '192.0.2.50'));

    expect(res.status).toBe(429);
    const retryAfter = Number(res.headers.get('Retry-After'));
    expect(retryAfter).toBeGreaterThan(840);
    expect(retryAfter).toBeLessThanOrEqual(900);
    expect((await res.json()).error).toBe('Too many sign-in attempts. Try again in 15 minutes.');
    expect(fake.prisma.user.findUnique).not.toHaveBeenCalled();
    expect(pbkdf2).not.toHaveBeenCalled();
  });

  it('refuses an IP after 10 attempts across different emails', async () => {
    await Promise.all(Array.from({ length: 10 }, (_, i) => login(loginRequest(`user${i}@example.com`, 'x', '203.0.113.9'))));

    const res = await login(loginRequest(ACCOUNT, PASSWORD, '203.0.113.9'));
    expect(res.status).toBe(429);

    const elsewhere = await login(loginRequest(ACCOUNT, PASSWORD, '198.51.100.7'));
    expect(elsewhere.status).toBe(200);
  });

  it('lets only 10 of 12 simultaneous guesses through to the password check', async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => login(loginRequest(ACCOUNT, `guess-${i}`, '203.0.113.9')))
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([...Array(10).fill(401), 429, 429]);
    expect(fake.prisma.user.findUnique).toHaveBeenCalledTimes(10);
  });

  it('does not count successful sign-ins, so a busy office IP is never locked out', async () => {
    for (let i = 0; i < 11; i++) {
      expect((await login(loginRequest(ACCOUNT, PASSWORD, '203.0.113.9'))).status).toBe(200);
    }
  });

  it('answers a non-string email or password with 400 before counting or reading anything', async () => {
    for (let i = 0; i < 11; i++) {
      expect((await login(loginRequest({ contains: '' }, PASSWORD, '203.0.113.9'))).status).toBe(400);
    }
    expect((await login(loginRequest(ACCOUNT, 12345678, '203.0.113.9'))).status).toBe(400);
    expect(fake.prisma.user.findUnique).not.toHaveBeenCalled();

    expect((await login(loginRequest(ACCOUNT, PASSWORD, '203.0.113.9'))).status).toBe(200);
  });
});
