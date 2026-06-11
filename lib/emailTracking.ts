/**
 * Email Tracking Utilities
 * 
 * Provides functions to inject open-tracking pixels and rewrite
 * links for click-tracking in HTML email bodies.
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

      // Skip mailto:, tel:, anchor links, and already-tracked URLs
      if (
        trimmedUrl.startsWith('mailto:') ||
        trimmedUrl.startsWith('tel:') ||
        trimmedUrl.startsWith('#') ||
        trimmedUrl.includes('/api/track/')
      ) {
        return fullMatch;
      }

      const trackedUrl = `${trackBaseUrl}?url=${encodeURIComponent(trimmedUrl)}`;
      return `${prefix}${quote}${trackedUrl}${quote}`;
    }
  );
}

/**
 * Applies both open-tracking pixel injection and click-tracking link
 * rewriting to an HTML email body based on campaign tracking settings.
 * 
 * For non-HTML (plain text) bodies, returns the body unchanged.
 */
export function applyEmailTracking(
  body: string,
  dispatchId: string,
  isHtml: boolean,
  trackOpens: boolean,
  trackClicks: boolean
): string {
  if (!isHtml) return body;

  let result = body;

  if (trackClicks) {
    result = rewriteLinksForTracking(result, dispatchId);
  }

  if (trackOpens) {
    result = injectTrackingPixel(result, dispatchId);
  }

  return result;
}
