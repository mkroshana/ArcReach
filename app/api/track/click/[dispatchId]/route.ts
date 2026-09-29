import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { engagementBotReason, LINK_BURST_SECONDS, MACHINE_EVENT_TYPE } from '@/lib/botFilter';
import { clickTarget, sentClickTargets } from '@/lib/emailTracking';
import { hasValidSession } from '@/lib/session';

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
 * HEAD and for a signed-in user of the app, which answer the same without
 * recording.
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
  let dispatch: {
    id: string;
    messageId: string;
    status: string;
    sentAt: Date;
    acceptedAt: Date | null;
    body: string | null;
  } | null;
  try {
    dispatch = await prisma.emailDispatch.findUnique({
      where: { id: dispatchId },
      select: { id: true, messageId: true, status: true, sentAt: true, acceptedAt: true, body: true },
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
    // An automated click (a scanner, crawler, link unfurler, a prefetch) is
    // kept as a machine click, which metrics never count. It still redirects.
    const userAgent = req.headers.get('user-agent');
    const botReason = engagementBotReason(dispatch, userAgent, 'click');
    if (botReason) {
      console.log(`[Track Click] Bot filter: ${botReason} for dispatch ${dispatch.id} (UA: ${userAgent}); recorded as a machine click.`);
    }
    const eventType = botReason ? MACHINE_EVENT_TYPE.click : 'click';

    // One click row and one machine click row per (dispatch, link): repeat
    // clicks of a link collapse, flagLinkBurst never adds a second machine
    // click, and only the email's own links get here, so a dispatch never has
    // more of either than links.
    try {
      const existingClick = await prisma.emailEvent.findFirst({
        where: { messageId: dispatch.messageId, eventType, clickedUrl: target },
      });
      if (!existingClick) {
        const click = await prisma.emailEvent.create({
          data: {
            messageId: dispatch.messageId,
            eventType,
            clickedUrl: target,
            ...(botReason ? { botReason } : {}),
          },
        });
        if (!botReason) {
          await flagLinkBurst(click);
        }
      }
    } catch (err) {
      console.error('[Track Click] Failed to record click event:', err);
    }
  }

  return NextResponse.redirect(destination);
}

/**
 * A scanner following every link of an email clicks several of them within
 * LINK_BURST_SECONDS; a person rarely does. Runs after a person's click is
 * recorded, so of two clicks recorded at once the later check always sees the
 * earlier one. When a different link of the email was clicked (by a person or
 * a machine) within LINK_BURST_SECONDS of this click, every person click of
 * the email from LINK_BURST_SECONDS before this one on becomes a machine click.
 * A link keeps one machine click row: a person click of a link that already
 * has one is deleted instead, so repeated bursts never add rows.
 */
async function flagLinkBurst(click: { messageId: string; clickedUrl: string | null; timestamp: Date }): Promise<void> {
  const since = new Date(click.timestamp.getTime() - LINK_BURST_SECONDS * 1000);
  const otherLink = await prisma.emailEvent.findFirst({
    where: {
      messageId: click.messageId,
      eventType: { in: ['click', MACHINE_EVENT_TYPE.click] },
      clickedUrl: { not: click.clickedUrl },
      timestamp: { gte: since },
    },
    select: { id: true },
  });
  if (!otherLink) return;

  const machineClicks = await prisma.emailEvent.findMany({
    where: { messageId: click.messageId, eventType: MACHINE_EVENT_TYPE.click },
    select: { clickedUrl: true },
  });
  const machineClickedLinks = machineClicks.flatMap((e) => (e.clickedUrl === null ? [] : [e.clickedUrl]));
  const burstClicks = { messageId: click.messageId, eventType: 'click', timestamp: { gte: since } };

  const { count: removed } = machineClickedLinks.length
    ? await prisma.emailEvent.deleteMany({ where: { ...burstClicks, clickedUrl: { in: machineClickedLinks } } })
    : { count: 0 };
  const { count: flagged } = await prisma.emailEvent.updateMany({
    where: burstClicks,
    data: { eventType: MACHINE_EVENT_TYPE.click, botReason: 'link-burst' },
  });
  console.log(
    `[Track Click] Bot filter: link-burst for message ${click.messageId}; ${flagged} click(s) recorded as machine clicks, ${removed} already recorded as machine clicks removed.`
  );
}

export async function GET(req: NextRequest, context: { params: Promise<{ dispatchId: string }> }) {
  // A signed-in user of the app following the link (the operator checking a
  // copy of the email) is not the recipient clicking it: redirect, record nothing.
  return trackClick(req, context, !(await hasValidSession(req)));
}

/**
 * HEAD answers as GET does but never records a click: link checkers and
 * security scanners send HEAD, a person clicking a link never does.
 */
export async function HEAD(req: NextRequest, context: { params: Promise<{ dispatchId: string }> }) {
  return trackClick(req, context, false);
}
