/**
 * Email Tracking Utilities
 * 
 * Provides functions to inject open-tracking pixels and rewrite
 * links for click-tracking in HTML email bodies, and to add the unsubscribe
 * link to HTML and plain-text bodies. Pure string work: the editor previews
 * run it in the browser, so unsubscribe tokens are signed by the caller
 * (lib/unsubscribeLink).
 */

const APP_URL = process.env.APP_URL || 'http://localhost:3000';

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

/**
 * Rewrites all <a href="..."> links in an HTML email body to route
 * through the click tracking endpoint: GET /api/track/click/[dispatchId]?url=...
 * 
 * Skips mailto: links, anchor (#) links, and the tracking pixel URL itself.
 */
export function rewriteLinksForTracking(htmlBody: string, dispatchId: string): string {
  const trackBaseUrl = `${APP_URL}/api/track/click/${dispatchId}`;

  // Match href="..." or href='...' in anchor tags
  return htmlBody.replace(
    /(<a\s[^>]*href\s*=\s*)(["'])([^"']+)\2/gi,
    (fullMatch, prefix, quote, originalUrl) => {
      const trimmedUrl = originalUrl.trim();

      // Skip mailto:, tel:, anchor links, unsubscribe links, and already-tracked URLs
      if (
        trimmedUrl.startsWith('mailto:') ||
        trimmedUrl.startsWith('tel:') ||
        trimmedUrl.startsWith('#') ||
        trimmedUrl.includes('/api/track/') ||
        trimmedUrl.includes('/api/unsubscribe')
      ) {
        return fullMatch;
      }

      const trackedUrl = `${trackBaseUrl}?url=${encodeURIComponent(trimmedUrl)}`;
      return `${prefix}${quote}${trackedUrl}${quote}`;
    }
  );
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
