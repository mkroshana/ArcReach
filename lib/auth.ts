import crypto from 'crypto';

// OWASP-recommended work factor for PBKDF2-HMAC-SHA512.
const PBKDF2_ITERATIONS = 210000;
const PBKDF2_KEYLEN = 64;
const PBKDF2_DIGEST = 'sha512';

// Legacy cost used by the original "salt:hash" format (pre-hardening).
const LEGACY_ITERATIONS = 1000;

// A current-format hash with a fixed salt and an all-zero digest: verifying against it costs exactly
// what a real current hash does, and no password realistically matches it.
const DUMMY_SALT = '0'.repeat(32);
const DUMMY_PASSWORD_HASH = `pbkdf2$${PBKDF2_ITERATIONS}$${DUMMY_SALT}$${'0'.repeat(PBKDF2_KEYLEN * 2)}`;

/** PBKDF2 on libuv's thread pool, so hashing never blocks the event loop the send worker shares. */
function pbkdf2(password: string, salt: string, iterations: number, keylen: number, digest: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(password, salt, iterations, keylen, digest, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/**
 * Hash a password using PBKDF2-SHA512 with a random salt.
 * Returns a versioned representation: "pbkdf2$<iterations>$<salt>$<hash>",
 * so the work factor travels with the hash and can be upgraded over time.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = (await pbkdf2(password, salt, PBKDF2_ITERATIONS, PBKDF2_KEYLEN, PBKDF2_DIGEST)).toString('hex');
  return `pbkdf2$${PBKDF2_ITERATIONS}$${salt}$${hash}`;
}

/**
 * Verify a password against a stored representation.
 * Supports both the new versioned format and the legacy "salt:hash" (1000-iter)
 * format so existing accounts keep working. Plain-text storage is NOT accepted.
 */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  if (!storedHash) return false;

  // New versioned format: pbkdf2$<iterations>$<salt>$<hash>
  if (storedHash.startsWith('pbkdf2$')) {
    const parts = storedHash.split('$');
    if (parts.length !== 4) return false;
    const iterations = parseInt(parts[1], 10);
    const salt = parts[2];
    const originalHash = parts[3];
    if (!iterations || !salt || !originalHash) return false;
    const hash = (await pbkdf2(password, salt, iterations, PBKDF2_KEYLEN, PBKDF2_DIGEST)).toString('hex');
    return timingSafeEqualHex(hash, originalHash);
  }

  // Legacy format: <salt>:<hash> (PBKDF2-SHA512 at 1000 iterations).
  if (storedHash.includes(':')) {
    const [salt, originalHash] = storedHash.split(':');
    if (!salt || !originalHash) return false;
    const hash = (await pbkdf2(password, salt, LEGACY_ITERATIONS, 64, 'sha512')).toString('hex');
    return timingSafeEqualHex(hash, originalHash);
  }

  // Unrecognized format (e.g. raw plaintext) — reject.
  return false;
}

/**
 * Verify a sign-in so it always costs at least the current work factor: a missing account
 * (no stored hash) is checked against a dummy hash and fails, and a cheaper legacy hash is
 * topped up with the iterations it lacks. Response time then does not reveal which emails
 * are registered.
 */
export async function verifyLoginPassword(password: string, storedHash: string | null | undefined): Promise<boolean> {
  if (!storedHash) {
    await verifyPassword(password, DUMMY_PASSWORD_HASH);
    return false;
  }
  const valid = await verifyPassword(password, storedHash);
  const spent = verifyIterations(storedHash);
  if (spent < PBKDF2_ITERATIONS) {
    await pbkdf2(password, DUMMY_SALT, PBKDF2_ITERATIONS - spent, PBKDF2_KEYLEN, PBKDF2_DIGEST);
  }
  return valid;
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

/** PBKDF2 iterations verifyPassword runs for `storedHash`: 0 when it rejects the format without hashing. */
function verifyIterations(storedHash: string): number {
  if (storedHash.startsWith('pbkdf2$')) {
    const parts = storedHash.split('$');
    const iterations = parseInt(parts[1], 10);
    return parts.length === 4 && iterations && parts[2] && parts[3] ? iterations : 0;
  }
  if (storedHash.includes(':')) {
    const [salt, originalHash] = storedHash.split(':');
    return salt && originalHash ? LEGACY_ITERATIONS : 0;
  }
  return 0;
}

/** Constant-time comparison of two hex-encoded digests. */
function timingSafeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
