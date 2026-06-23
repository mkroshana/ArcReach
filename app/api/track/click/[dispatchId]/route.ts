import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { shouldDropEvent } from '@/lib/botFilter';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ dispatchId: string }> }
) {
  const { searchParams } = new URL(req.url);
  const targetUrl = searchParams.get('url');

  // Fallback destination if URL param is missing or invalid
  const fallbackUrl = process.env.APP_URL || 'http://localhost:3000';

  if (!targetUrl) {
    return NextResponse.redirect(fallbackUrl);
  }

  let isSafe = false;

  // 1. Check if it's a relative URL or matches the application's domain
  try {
    const parsedAppUrl = new URL(fallbackUrl);
    const parsedTargetUrl = new URL(targetUrl);
    if (parsedTargetUrl.hostname === parsedAppUrl.hostname) {
      isSafe = true;
    }
  } catch (e) {
    // If it's a relative path starting with '/' and not '//'
    if (targetUrl.startsWith('/') && !targetUrl.startsWith('//')) {
      isSafe = true;
    }
  }

  try {
    const { dispatchId } = await params;

    // Look up the dispatch record
    const dispatch = await prisma.emailDispatch.findUnique({
      where: { id: dispatchId },
    });

    if (dispatch) {
      // 2. If it's an external URL, verify that it was actually part of the email body sent
      if (!isSafe && dispatch.body) {
        if (dispatch.body.includes(targetUrl) || dispatch.body.includes(encodeURIComponent(targetUrl))) {
          isSafe = true;
        }
      }

      // Apply bot filter to clicks
      const userAgent = req.headers.get('user-agent');
      const botFilter = shouldDropEvent(dispatch.sentAt, userAgent, 'click');

      if (botFilter.drop) {
        console.log(`[Track Click] Bot filter: ${botFilter.reason || 'dropped'} for dispatch ${dispatch.id} (UA: ${userAgent})`);
      } else {
        // Dedupe per (dispatch, url): collapse repeat clicks of the same link, but keep
        // distinct links so per-URL click data is preserved.
        const existingClick = await prisma.emailEvent.findFirst({
          where: { messageId: dispatch.messageId, eventType: 'click', clickedUrl: targetUrl },
        });
        if (!existingClick) {
          await prisma.emailEvent.create({
            data: {
              messageId: dispatch.messageId,
              eventType: 'click',
              clickedUrl: targetUrl,
            },
          }).catch((err) => {
            console.error('[Track Click] Failed to record click event:', err);
          });
        }
      }
    } else {
      console.log(`[Track Click] Dispatch not found: ${dispatchId}`);
    }
  } catch (err) {
    console.error('[Track Click] Error:', err);
  }

  // Ensure targetUrl doesn't use unsafe protocols (e.g. javascript:)
  if (isSafe) {
    try {
      const parsed = new URL(targetUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        isSafe = false;
      }
    } catch (e) {
      // Relative path is fine
    }
  }

  // Always redirect to the target URL if safe, otherwise to fallback
  return NextResponse.redirect(isSafe ? targetUrl : fallbackUrl);
}
