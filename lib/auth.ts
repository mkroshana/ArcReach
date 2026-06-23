import crypto from 'crypto';

// OWASP-recommended work factor for PBKDF2-HMAC-SHA512.
const PBKDF2_ITERATIONS = 210000;
const PBKDF2_KEYLEN = 64;
const PBKDF2_DIGEST = 'sha512';

// Legacy cost used by the original "salt:hash" format (pre-hardening).
const LEGACY_ITERATIONS = 1000;

/**
 * Hash a password using PBKDF2-SHA512 with a random salt.
 * Returns a versioned representation: "pbkdf2$<iterations>$<salt>$<hash>",
 * so the work factor travels with the hash and can be upgraded over time.
 */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto
    .pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, PBKDF2_KEYLEN, PBKDF2_DIGEST)
    .toString('hex');
  return `pbkdf2$${PBKDF2_ITERATIONS}$${salt}$${hash}`;
}

/**
 * Verify a password against a stored representation.
 * Supports both the new versioned format and the legacy "salt:hash" (1000-iter)
 * format so existing accounts keep working. Plain-text storage is NOT accepted.
 */
export function verifyPassword(password: string, storedHash: string): boolean {
  if (!storedHash) return false;

  // New versioned format: pbkdf2$<iterations>$<salt>$<hash>
  if (storedHash.startsWith('pbkdf2$')) {
    const parts = storedHash.split('$');
    if (parts.length !== 4) return false;
    const iterations = parseInt(parts[1], 10);
    const salt = parts[2];
    const originalHash = parts[3];
    if (!iterations || !salt || !originalHash) return false;
    const hash = crypto
      .pbkdf2Sync(password, salt, iterations, PBKDF2_KEYLEN, PBKDF2_DIGEST)
      .toString('hex');
    return timingSafeEqualHex(hash, originalHash);
  }

  // Legacy format: <salt>:<hash> (PBKDF2-SHA512 at 1000 iterations).
  if (storedHash.includes(':')) {
    const [salt, originalHash] = storedHash.split(':');
    if (!salt || !originalHash) return false;
    const hash = crypto
      .pbkdf2Sync(password, salt, LEGACY_ITERATIONS, 64, 'sha512')
      .toString('hex');
    return timingSafeEqualHex(hash, originalHash);
  }

  // Unrecognized format (e.g. raw plaintext) — reject.
  return false;
}

/**
 * Returns true if a stored hash uses an outdated format or work factor and
 * should be re-hashed (call hashPassword and persist) after a successful login.
 */
export function needsRehash(storedHash: string): boolean {
  if (!storedHash) return false;
  if (storedHash.startsWith('pbkdf2$')) {
    const iterations = parseInt(storedHash.split('$')[1], 10);
    return !iterations || iterations < PBKDF2_ITERATIONS;
  }
  // Legacy salt:hash or anything else → upgrade.
  return true;
}

/** Constant-time comparison of two hex-encoded digests. */
function timingSafeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
