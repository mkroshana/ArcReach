import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

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

      // A click implies the email was opened — record an implicit open
      // if one hasn't been recorded yet for this dispatch.
      // Many email clients block remote images (the tracking pixel),
      // but a click proves the email was opened.
      const existingOpen = await prisma.emailEvent.findFirst({
        where: {
          messageId: dispatch.messageId,
          eventType: 'open',
        },
      });

      if (!existingOpen) {
        await prisma.emailEvent.create({
          data: {
            messageId: dispatch.messageId,
            eventType: 'open',
          },
        }).catch((err) => {
          console.error('[Track Click] Failed to record implicit open event:', err);
        });
      }

      // Record the click event
      await prisma.emailEvent.create({
        data: {
          messageId: dispatch.messageId,
          eventType: 'click',
          clickedUrl: targetUrl,
        },
      }).catch((err) => {
        console.error('[Track Click] Failed to record click event:', err);
      });
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
