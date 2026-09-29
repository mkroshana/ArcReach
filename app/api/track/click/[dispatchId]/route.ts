import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { shouldDropEvent } from '@/lib/botFilter';
import { clickTarget, sentClickTargets } from '@/lib/emailTracking';

// The page is self-contained: inline styles only, no scripts, external
// resources, forms or framing.
const HTML_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'Cache-Control': 'no-store',
};

/**
 * The neutral page for a link this endpoint will not follow: its dispatch is
 * gone, or its url is not one of the links that email sent. It names no app
 * and links nowhere.
 */
function linkUnavailable(status = 404, message = 'This link is no longer available.'): NextResponse {
  return new NextResponse(
    `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Link Unavailable</title>
  <style>
    body {
      margin: 0;
      padding: 1rem;
      min-height: 100vh;
      box-sizing: border-box;
      display: flex;
      justify-content: center;
      align-items: center;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
      background: #fafafa;
      color: #525252;
      text-align: center;
    }
    h1 { margin: 0 0 0.5rem; font-size: 1.25rem; color: #171717; }
    p { margin: 0; font-size: 0.95rem; line-height: 1.6; }
  </style>
</head>
<body>
  <main>
    <h1>Link Unavailable</h1>
    <p>${message}</p>
  </main>
</body>
</html>`,
    { status, headers: HTML_HEADERS }
  );
}

/**
 * The absolute http(s) URL to redirect to for a target the email sent. A
 * relative target resolves against APP_URL. Null for any other scheme
 * (javascript:, data: ...) or a target that is not a URL.
 */
function redirectUrl(target: string): string | null {
  try {
    const url = new URL(target, process.env.APP_URL || 'http://localhost:3000');
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * GET /api/track/click/[dispatchId]?url=<target>
 *
 * Public endpoint. Redirects to the target, and records the click, only when
 * the target is exactly one of the links this dispatch's email sent (see
 * sentClickTargets): anything else, or a dispatch that is gone, gets the
 * neutral page, records nothing and redirects nowhere. `record` is false for
 * HEAD, which answers the same without recording.
 */
async function trackClick(
  req: NextRequest,
  { params }: { params: Promise<{ dispatchId: string }> },
  record: boolean
): Promise<NextResponse> {
  const target = clickTarget(req.nextUrl.searchParams.get('url') ?? '');
  if (target === null) {
    return linkUnavailable();
  }

  const { dispatchId } = await params;
  let dispatch: { id: string; messageId: string; sentAt: Date; body: string | null } | null;
  try {
    dispatch = await prisma.emailDispatch.findUnique({
      where: { id: dispatchId },
      select: { id: true, messageId: true, sentAt: true, body: true },
    });
  } catch (err) {
    console.error('[Track Click] Error:', err);
    return linkUnavailable(503, 'This link could not be opened right now. Please try again later.');
  }

  if (!dispatch) {
    console.log(`[Track Click] Dispatch not found: ${dispatchId}`);
    return linkUnavailable();
  }

  const destination = sentClickTargets(dispatch.body, dispatch.id).has(target) ? redirectUrl(target) : null;
  if (!destination) {
    console.log(`[Track Click] Not a link dispatch ${dispatch.id} sent; not redirecting.`);
    return linkUnavailable();
  }

  if (record) {
    // Apply bot filter to clicks
    const userAgent = req.headers.get('user-agent');
    const botFilter = shouldDropEvent(dispatch.sentAt, userAgent, 'click');

    if (botFilter.drop) {
      console.log(`[Track Click] Bot filter: ${botFilter.reason || 'dropped'} for dispatch ${dispatch.id} (UA: ${userAgent})`);
    } else {
      // One click row per (dispatch, link): repeat clicks of a link collapse,
      // and only the email's own links get here, so a dispatch never has more
      // click rows than links.
      try {
        const existingClick = await prisma.emailEvent.findFirst({
          where: { messageId: dispatch.messageId, eventType: 'click', clickedUrl: target },
        });
        if (!existingClick) {
          await prisma.emailEvent.create({
            data: {
              messageId: dispatch.messageId,
              eventType: 'click',
              clickedUrl: target,
            },
          });
        }
      } catch (err) {
        console.error('[Track Click] Failed to record click event:', err);
      }
    }
  }

  return NextResponse.redirect(destination);
}

export async function GET(req: NextRequest, context: { params: Promise<{ dispatchId: string }> }) {
  return trackClick(req, context, true);
}

/**
 * HEAD answers as GET does but never records a click: link checkers and
 * security scanners send HEAD, a person clicking a link never does.
 */
export async function HEAD(req: NextRequest, context: { params: Promise<{ dispatchId: string }> }) {
  return trackClick(req, context, false);
}
