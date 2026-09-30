import { describe, it, expect, vi, afterEach } from 'vitest';
import crypto from 'crypto';
import { hashPassword, verifyPassword, verifyLoginPassword, needsRehash } from '@/lib/auth';

/** Total PBKDF2 iterations run through the spied crypto.pbkdf2. */
function iterationsRun(spy: { mock: { calls: unknown[][] } }): number {
  return spy.mock.calls.reduce((sum, call) => sum + (call[2] as number), 0);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('auth password hashing', () => {
  it('hashes in the versioned pbkdf2 format and verifies it', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(stored.startsWith('pbkdf2$210000$')).toBe(true);
    expect(await verifyPassword('correct horse battery staple', stored)).toBe(true);
    expect(await verifyPassword('wrong password', stored)).toBe(false);
  });

  it('still verifies the legacy salt:hash (1000-iter) format', async () => {
    const salt = 'a1b2c3d4e5f6';
    const hash = crypto.pbkdf2Sync('legacypw', salt, 1000, 64, 'sha512').toString('hex');
    const legacy = `${salt}:${hash}`;
    expect(await verifyPassword('legacypw', legacy)).toBe(true);
    expect(await verifyPassword('nope', legacy)).toBe(false);
  });

  it('rejects raw plaintext and empty stored values', async () => {
    expect(await verifyPassword('plain', 'plain')).toBe(false);
    expect(await verifyPassword('x', '')).toBe(false);
  });

  it('flags legacy and low-cost hashes for rehash but not current ones', async () => {
    const salt = 'a1b2c3d4e5f6';
    const hash = crypto.pbkdf2Sync('pw', salt, 1000, 64, 'sha512').toString('hex');
    expect(needsRehash(`${salt}:${hash}`)).toBe(true);
    expect(needsRehash('pbkdf2$1000$abc$def')).toBe(true);
    expect(needsRehash(await hashPassword('pw'))).toBe(false);
    expect(needsRehash('')).toBe(false);
  });

  it('hashes and verifies off the event loop (M48)', async () => {
    const pbkdf2Sync = vi.spyOn(crypto, 'pbkdf2Sync');
    let timerRan = false;
    setImmediate(() => { timerRan = true; });

    // Synchronous PBKDF2 would finish before the queued callback got a turn.
    const stored = await hashPassword('pw');
    expect(timerRan).toBe(true);

    timerRan = false;
    setImmediate(() => { timerRan = true; });
    expect(await verifyPassword('pw', stored)).toBe(true);
    expect(timerRan).toBe(true);
    expect(pbkdf2Sync).not.toHaveBeenCalled();
  });
});

describe('verifyLoginPassword (M48)', () => {
  it('fails a missing account after the same PBKDF2 work as a current hash', async () => {
    const stored = await hashPassword('right-password');
    const pbkdf2 = vi.spyOn(crypto, 'pbkdf2');

    expect(await verifyLoginPassword('right-password', stored)).toBe(true);
    expect(iterationsRun(pbkdf2)).toBe(210000);

    for (const missing of [null, undefined, '']) {
      pbkdf2.mockClear();
      expect(await verifyLoginPassword('right-password', missing)).toBe(false);
      expect(iterationsRun(pbkdf2)).toBe(210000);
    }
  });

  it('tops a legacy or unrecognized hash up to the current work factor', async () => {
    const salt = 'a1b2c3d4e5f6';
    const legacy = `${salt}:${crypto.pbkdf2Sync('legacypw', salt, 1000, 64, 'sha512').toString('hex')}`;
    const pbkdf2 = vi.spyOn(crypto, 'pbkdf2');

    expect(await verifyLoginPassword('legacypw', legacy)).toBe(true);
    expect(iterationsRun(pbkdf2)).toBe(210000);

    pbkdf2.mockClear();
    expect(await verifyLoginPassword('nope', legacy)).toBe(false);
    expect(iterationsRun(pbkdf2)).toBe(210000);

    pbkdf2.mockClear();
    expect(await verifyLoginPassword('plain', 'plain')).toBe(false);
    expect(iterationsRun(pbkdf2)).toBe(210000);
  });
});
