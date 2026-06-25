/**
 * Application-level envelope encryption for secrets at rest.
 *
 * Stored format: `enc:v1:<base64(iv)>:<base64(ciphertext||authTag)>`
 *  - AES-256-GCM with a random 12-byte IV per encrypt
 *  - 32-byte key derived from SECRETS_KEY (raw or hex)
 *  - GCM auth tag is appended to the ciphertext, so tampering is detected on decrypt
 *
 * Migration-safe: `decryptSecret` passes through any value that lacks the
 * `enc:v1:` prefix, treating it as legacy plaintext. This way existing rows
 * keep working until they're re-saved, at which point writes upgrade to ciphertext.
 */
import crypto from 'crypto';

const ENC_PREFIX = 'enc:v1:';
const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;
const DEV_FALLBACK_KEY = 'dev_secrets_key_change_me_32_bytes!!';

/** Sentinel returned in place of stored secrets in API responses; writes ignore
 *  this value so a round-tripped mask never overwrites the real secret. */
export const MASKED_SECRET = '••••••••';

function resolveKey(): Buffer {
  const raw = process.env.SECRETS_KEY || DEV_FALLBACK_KEY;

  // Allow hex (64 chars) or raw string of at least KEY_BYTES bytes.
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, 'hex');
  }
  const buf = Buffer.from(raw, 'utf8');
  if (buf.length < KEY_BYTES) {
    // Stretch short keys via SHA-256 so dev fallback still works; a real
    // production key is enforced by the guard below.
    return crypto.createHash('sha256').update(buf).digest();
  }
  return buf.subarray(0, KEY_BYTES);
}

const isBuildPhase = process.env.NEXT_PHASE === 'phase-production-build';
if (
  !isBuildPhase &&
  process.env.NODE_ENV === 'production' &&
  (!process.env.SECRETS_KEY || process.env.SECRETS_KEY.length < 32)
) {
  throw new Error(
    'SECRETS_KEY environment variable must be set and at least 32 characters long in production.'
  );
}

const KEY = resolveKey();

/** Encrypt a plaintext string. Returns the prefixed, base64-encoded ciphertext. */
export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, KEY, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString('base64')}:${Buffer.concat([ct, tag]).toString('base64')}`;
}

/**
 * Decrypt a stored secret. Pass-through for legacy plaintext (any value missing
 * the `enc:v1:` prefix is returned unchanged). Returns null/undefined as-is.
 */
export function decryptSecret(stored: string | null | undefined): string | null | undefined {
  if (stored == null) return stored;
  if (!stored.startsWith(ENC_PREFIX)) return stored;

  const rest = stored.slice(ENC_PREFIX.length);
  const sep = rest.indexOf(':');
  if (sep === -1) throw new Error('Malformed encrypted secret: missing IV separator.');

  const iv = Buffer.from(rest.slice(0, sep), 'base64');
  const blob = Buffer.from(rest.slice(sep + 1), 'base64');
  if (blob.length < 16) throw new Error('Malformed encrypted secret: payload too short.');

  const tag = blob.subarray(blob.length - 16);
  const ct = blob.subarray(0, blob.length - 16);

  const decipher = crypto.createDecipheriv(ALGO, KEY, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
  return plain.toString('utf8');
}

/** True when `stored` is the `enc:v1:` envelope (i.e. already encrypted). */
export function isEncrypted(stored: string | null | undefined): boolean {
  return typeof stored === 'string' && stored.startsWith(ENC_PREFIX);
}
