import { describe, it, expect } from 'vitest';
import { encryptSecret, decryptSecret, isEncrypted, MASKED_SECRET } from '../../lib/secrets';

describe('encryptSecret / decryptSecret', () => {
  it('round-trips an arbitrary plaintext', () => {
    const plain = 'endpoint=https://example.communication.azure.com/;accesskey=abc123';
    const cipher = encryptSecret(plain);
    expect(cipher).not.toContain(plain);
    expect(isEncrypted(cipher)).toBe(true);
    expect(decryptSecret(cipher)).toBe(plain);
  });

  it('produces a distinct ciphertext each call (fresh IV)', () => {
    const a = encryptSecret('same-input');
    const b = encryptSecret('same-input');
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe('same-input');
    expect(decryptSecret(b)).toBe('same-input');
  });

  it('detects ciphertext tampering via the GCM auth tag', () => {
    const cipher = encryptSecret('untouchable');
    // Flip a byte in the base64 payload (after the second colon)
    const lastColon = cipher.lastIndexOf(':');
    const head = cipher.slice(0, lastColon + 1);
    const tail = cipher.slice(lastColon + 1);
    const tampered = head + (tail[0] === 'A' ? 'B' : 'A') + tail.slice(1);
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it('passes legacy plaintext through unchanged (migration-safe)', () => {
    expect(decryptSecret('legacy-plain-password')).toBe('legacy-plain-password');
    expect(isEncrypted('legacy-plain-password')).toBe(false);
  });

  it('passes null/undefined through unchanged', () => {
    expect(decryptSecret(null)).toBeNull();
    expect(decryptSecret(undefined)).toBeUndefined();
  });

  it('exports the redaction sentinel for shared use', () => {
    expect(MASKED_SECRET).toBe('••••••••');
  });
});
