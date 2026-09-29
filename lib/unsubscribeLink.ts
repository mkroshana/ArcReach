/**
 * Signed unsubscribe links for campaign emails. Each link carries a token that
 * binds the lead to the dispatch it was sent in, signed with HMAC-SHA256 under
 * UNSUBSCRIBE_SECRET, so /api/unsubscribe acts only on links this app issued.
 * Server only (Node crypto): lib/emailTracking stays free of it because the
 * editor previews run it in the browser.
 *
 * Token: base64url(leadId).base64url(dispatchId).base64url(signature)
 *
 * Every link already sent is signed with the secret, so changing it breaks
 * them all: set it once per deployment and keep it.
 */
import crypto from 'crypto';
import { unsubscribeUrl } from './emailTracking';

const DEV_FALLBACK_SECRET = 'dev_unsubscribe_secret_change_me_32_chars';

// Skipped while `next build` collects page data, as in lib/sessionSecret.
const isBuildPhase = process.env.NEXT_PHASE === 'phase-production-build';
if (
  !isBuildPhase &&
  process.env.NODE_ENV === 'production' &&
  (!process.env.UNSUBSCRIBE_SECRET || process.env.UNSUBSCRIBE_SECRET.length < 32)
) {
  throw new Error(
    'UNSUBSCRIBE_SECRET environment variable must be set and at least 32 characters long in production.'
  );
}

const SECRET = process.env.UNSUBSCRIBE_SECRET || DEV_FALLBACK_SECRET;

function signature(payload: string): string {
  return crypto.createHmac('sha256', SECRET).update(`unsubscribe:v1:${payload}`).digest('base64url');
}

/** The token for the unsubscribe link of the email sent to `leadId` as dispatch `dispatchId`. */
export function signUnsubscribeToken(leadId: string, dispatchId: string): string {
  const payload = `${Buffer.from(leadId).toString('base64url')}.${Buffer.from(dispatchId).toString('base64url')}`;
  return `${payload}.${signature(payload)}`;
}

/** The lead and dispatch a token was signed for, or null when it is malformed or its signature does not match. */
export function verifyUnsubscribeToken(token: string): { leadId: string; dispatchId: string } | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [lead, dispatch, given] = parts;
  const expected = Buffer.from(signature(`${lead}.${dispatch}`));
  const actual = Buffer.from(given);
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  const leadId = Buffer.from(lead, 'base64url').toString('utf8');
  const dispatchId = Buffer.from(dispatch, 'base64url').toString('utf8');
  return leadId && dispatchId ? { leadId, dispatchId } : null;
}

/**
 * The List-Unsubscribe headers of a campaign email whose signed token is
 * `token`: its https link, then a mailto to UNSUBSCRIBE_MAILTO when that is
 * set. List-Unsubscribe-Post asks mail clients for an RFC 8058 one-click POST
 * to the link, which RFC 8058 allows only for an https link.
 */
export function listUnsubscribeHeaders(token: string): Record<string, string> {
  const url = unsubscribeUrl(token);
  const targets = [`<${url}>`];
  const mailto = process.env.UNSUBSCRIBE_MAILTO?.trim();
  if (mailto) targets.push(`<mailto:${mailto}?subject=unsubscribe>`);

  const headers: Record<string, string> = { 'List-Unsubscribe': targets.join(', ') };
  if (url.startsWith('https://')) headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  return headers;
}
