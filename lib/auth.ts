import crypto from 'crypto';

/**
 * Hash a password using PBKDF2 with SHA512 and a random 16-byte salt.
 * Returns the hash representation as "salt:hash".
 */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

/**
 * Verify a password against a stored representation.
 * Supports plain-text comparison for backward compatibility with seeded users.
 */
export function verifyPassword(password: string, storedHash: string): boolean {
  if (!storedHash) return false;

  // Backward compatibility check (if no salt separator ":" exists, treat as plain text)
  if (!storedHash.includes(':')) {
    return password === storedHash;
  }

  const [salt, originalHash] = storedHash.split(':');
  const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return hash === originalHash;
}
