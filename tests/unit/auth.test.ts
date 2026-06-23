import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { hashPassword, verifyPassword, needsRehash } from '@/lib/auth';

describe('auth password hashing', () => {
  it('hashes in the versioned pbkdf2 format and verifies it', () => {
    const stored = hashPassword('correct horse battery staple');
    expect(stored.startsWith('pbkdf2$210000$')).toBe(true);
    expect(verifyPassword('correct horse battery staple', stored)).toBe(true);
    expect(verifyPassword('wrong password', stored)).toBe(false);
  });

  it('still verifies the legacy salt:hash (1000-iter) format', () => {
    const salt = 'a1b2c3d4e5f6';
    const hash = crypto.pbkdf2Sync('legacypw', salt, 1000, 64, 'sha512').toString('hex');
    const legacy = `${salt}:${hash}`;
    expect(verifyPassword('legacypw', legacy)).toBe(true);
    expect(verifyPassword('nope', legacy)).toBe(false);
  });

  it('rejects raw plaintext and empty stored values', () => {
    expect(verifyPassword('plain', 'plain')).toBe(false);
    expect(verifyPassword('x', '')).toBe(false);
  });

  it('flags legacy and low-cost hashes for rehash but not current ones', () => {
    const salt = 'a1b2c3d4e5f6';
    const hash = crypto.pbkdf2Sync('pw', salt, 1000, 64, 'sha512').toString('hex');
    expect(needsRehash(`${salt}:${hash}`)).toBe(true);
    expect(needsRehash('pbkdf2$1000$abc$def')).toBe(true);
    expect(needsRehash(hashPassword('pw'))).toBe(false);
    expect(needsRehash('')).toBe(false);
  });
});
