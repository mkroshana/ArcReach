/**
 * Email Tracking Utilities
 * 
 * Provides functions to inject open-tracking pixels and rewrite
 * links for click-tracking in HTML email bodies, and to add the unsubscribe
 * link to HTML and plain-text bodies. Pure string work: the editor previews
 * run it in the browser, so unsubscribe tokens are signed by the caller
 * (lib/unsubscribeLink).
 */

import { decodeEntities } from './emailText';
import { requireProductionAppUrl } from './productionEnv';

// A production server needs a public https APP_URL (lib/productionEnv), so no email is
// sent with localhost links. The browser never sees APP_URL: the editor previews build
// their links on the local fallback.
if (typeof window === 'undefined') requireProductionAppUrl(process.env.APP_URL);

// Trimmed and without a trailing slash, so links are never `https://host//api/...`.
const APP_URL = (process.env.APP_URL?.trim() || 'http://localhost:3000').replace(/\/+$/, '');

/**
 * Injects a 1×1 tracking pixel <img> tag into an HTML email body.
 * The pixel hits GET /api/track/open/[dispatchId] when loaded.
 */
export function injectTrackingPixel(htmlBody: string, dispatchId: string): string {
  const pixelUrl = `${APP_URL}/api/track/open/${dispatchId}`;
  const pixelTag = `<img src="${pixelUrl}" width="1" height="1" style="display:none;border:0;outline:none;" alt="" />`;

  // Insert before </body> if present, otherwise append at the end
  if (htmlBody.toLowerCase().includes('</body>')) {
    return htmlBody.replace(/<\/body>/i, `${pixelTag}</body>`);
  }

  return htmlBody + pixelTag;
}

// Matches href="..." or href='...' in anchor tags
const ANCHOR_HREF = /(<a\s[^>]*href\s*=\s*)(["'])([^"']+)\2/gi;

/**
 * The URL a click-tracked link for this href sends the recipient to: the href
 * as a mail client opens it, with HTML character references (&amp;) decoded.
 * Null for links that are not click-tracked: mailto:, tel:, anchor links,
 * unsubscribe links and already-tracked URLs. Applied both when links are
 * rewritten and when the click route matches a click's url against them.
 */
export function clickTarget(href: string): string | null {
  const url = decodeEntities(href).trim();
  if (
    !url ||
    url.startsWith('mailto:') ||
    url.startsWith('tel:') ||
    url.startsWith('#') ||
    url.includes('/api/track/') ||
    url.includes('/api/unsubscribe')
  ) {
    return null;
  }
  return url;
}

/**
 * Rewrites all <a href="..."> links in an HTML email body to route
 * through the click tracking endpoint: GET /api/track/click/[dispatchId]?url=...
 *
 * Skips the links clickTarget does not track.
 */
export function rewriteLinksForTracking(htmlBody: string, dispatchId: string): string {
  const trackBaseUrl = `${APP_URL}/api/track/click/${dispatchId}`;

  return htmlBody.replace(ANCHOR_HREF, (fullMatch, prefix, quote, originalUrl) => {
    const target = clickTarget(originalUrl);
    if (target === null) {
      return fullMatch;
    }

    // A decoded &#39; is a quote encodeURIComponent keeps, and it would end a single-quoted href.
    const trackedUrl = `${trackBaseUrl}?url=${encodeURIComponent(target).replace(/'/g, '%27')}`;
    return `${prefix}${quote}${trackedUrl}${quote}`;
  });
}

/**
 * The click targets a stored dispatch body really sent (see clickTarget): the
 * url of each link tracked for this dispatch, and each link that would be
 * tracked in a body stored before its links were rewritten (a send still
 * Sending or settled by the reconciler). The click route records and
 * redirects only to these.
 */
export function sentClickTargets(body: string | null | undefined, dispatchId: string): Set<string> {
  const targets = new Set<string>();
  if (!body) return targets;

  const trackPath = `/api/track/click/${dispatchId}`;
  for (const [, , , href] of body.matchAll(ANCHOR_HREF)) {
    let target: string | null;
    if (href.includes('/api/track/click/')) {
      // A tracked link: its url, if it is this dispatch's.
      try {
        const tracked = new URL(decodeEntities(href).trim(), APP_URL);
        const url = tracked.pathname === trackPath ? tracked.searchParams.get('url') : null;
        target = url === null ? null : clickTarget(url);
      } catch {
        target = null;
      }
    } else {
      target = clickTarget(href);
    }
    if (target !== null) targets.add(target);
  }
  return targets;
}

/**
 * The domains emails sent before the 2026-10 campaign history reset linked to.
 * The reset deleted those emails' dispatches, so the click route can no longer
 * check a click on them against the links the email sent; when a click's
 * dispatch is gone it still redirects to these domains and their subdomains
 * (see onPreResetLinkDomain), and to nothing else.
 */
export const PRE_RESET_LINK_DOMAINS: readonly string[] = ['jobpromax.com', 'thejobhelpers.com', 'calendly.com'];

/**
 * Whether `url`, an absolute http(s) URL, is on one of PRE_RESET_LINK_DOMAINS
 * or a subdomain of one, and carries no credentials. The parsed hostname must
 * equal the domain or end in '.' + domain, so jobpromax.com.evil.test,
 * evil-jobpromax.com and https://jobpromax.com@evil.test never match. False for
 * anything that does not parse, including a relative URL.
 */
export function onPreResetLinkDomain(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (parsed.username || parsed.password) return false;

  const host = parsed.hostname.toLowerCase();
  // No empty label: .jobpromax.com and jobpromax.com. are not hosts emails linked to.
  if (host.split('.').some((label) => label === '')) return false;
  return PRE_RESET_LINK_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/**
 * The unsubscribe link for a signed token (lib/unsubscribeLink):
 * /api/unsubscribe?token=<token>. GET shows a confirmation page, and POST, from
 * its button or a mail client's one-click unsubscribe, unsubscribes.
 */
export function unsubscribeUrl(token?: string): string {
  return token ? `${APP_URL}/api/unsubscribe?token=${encodeURIComponent(token)}` : `${APP_URL}/api/unsubscribe`;
}

/**
 * Injects an unsubscribe footer link into the HTML email body.
 * The link points to /api/unsubscribe?token=<token>.
 */
export function injectUnsubscribeLink(htmlBody: string, token: string): string {
  const unsubUrl = unsubscribeUrl(token);
  const footer = `<div style="margin-top:32px;padding-top:16px;border-top:1px solid #e5e5e5;text-align:center;font-size:11px;color:#999;font-family:Arial,sans-serif;">If you no longer wish to receive these emails, <a href="${unsubUrl}" style="color:#999;text-decoration:underline;">click here to unsubscribe</a>.</div>`;

  // Insert before </body> if present, otherwise append at the end
  if (htmlBody.toLowerCase().includes('</body>')) {
    return htmlBody.replace(/<\/body>/i, `${footer}</body>`);
  }

  return htmlBody + footer;
}

/**
 * Applies open-tracking pixel injection, click-tracking link rewriting,
 * and unsubscribe link injection to an HTML email body based on campaign
 * tracking settings. `unsubscribeToken` is the signed token of this lead and
 * dispatch (lib/unsubscribeLink).
 * 
 * A plain-text body gets its unsubscribe placeholders filled in and, when it
 * has none, an 'Unsubscribe: <url>' line at the end. Opens and clicks cannot
 * be tracked in plain text.
 */
export function applyEmailTracking(
  body: string,
  dispatchId: string,
  isHtml: boolean,
  trackOpens: boolean,
  trackClicks: boolean,
  unsubscribeToken?: string
): string {
  let result = body;

  // Check if the body contains a custom unsubscribe placeholder
  const hasCustomUnsub = /\[\[\s*unsubscribe_url\s*\]\]/i.test(body) || /\{\{\s*unsubscribe_url\s*\}\}/i.test(body);

  // Replace custom unsubscribe placeholders [[unsubscribe_url]] or {{unsubscribe_url}}
  const unsubUrl = unsubscribeUrl(unsubscribeToken);

  result = result.replace(/\[\[\s*unsubscribe_url\s*\]\]/gi, unsubUrl);
  result = result.replace(/\{\{\s*unsubscribe_url\s*\}\}/gi, unsubUrl);

  // Plain text: no pixel or link rewriting, and the default link is a last line
  if (!isHtml) {
    return unsubscribeToken && !hasCustomUnsub ? `${result.trimEnd()}\n\nUnsubscribe: ${unsubUrl}` : result;
  }

  // Inject default unsubscribe link if a token is present and no custom unsubscribe link was provided
  if (unsubscribeToken && !hasCustomUnsub) {
    result = injectUnsubscribeLink(result, unsubscribeToken);
  }

  if (trackClicks) {
    result = rewriteLinksForTracking(result, dispatchId);
  }

  if (trackOpens) {
    result = injectTrackingPixel(result, dispatchId);
  }

  return result;
}
